/**
 * Reusable bounded-concurrency limiter and hash-keyed trace verification cache
 * (Issue #243).
 *
 * Prevents hammering IPFS gateways when rendering markets with many traces:
 *  - `ConcurrencyLimiter`: bounds concurrent async tasks and supports `AbortSignal`.
 *  - `TraceVerificationCache`: caches verified results keyed by `(traceId, hash)`
 *    so a verified result is never served for a different hash, and negative-caches
 *    failures for a short TTL (`DEFAULT_NEGATIVE_TTL_MS`).
 */

import type { TraceCheck } from "@/lib/stellar/trace-core";
import { normalizeHash } from "@/lib/stellar/trace";

export const DEFAULT_VERIFICATION_CONCURRENCY = 3;
export const DEFAULT_NEGATIVE_TTL_MS = 30_000;

interface QueuedTask {
  run: () => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: QueuedTask[] = [];

  constructor(readonly maxConcurrency: number = DEFAULT_VERIFICATION_CONCURRENCY) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new RangeError("maxConcurrency must be an integer >= 1");
    }
  }

  get activeCount(): number {
    return this.active;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(new DOMException("Task aborted", "AbortError"));
    }

    return new Promise<T>((resolve, reject) => {
      const execute = () => {
        if (signal?.aborted) {
          reject(new DOMException("Task aborted", "AbortError"));
          this.drain();
          return;
        }
        this.active++;
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            this.active--;
            this.drain();
          });
      };

      if (this.active < this.maxConcurrency) {
        execute();
        return;
      }

      const task: QueuedTask = { run: execute, signal };
      if (signal) {
        const onAbort = () => {
          const idx = this.queue.indexOf(task);
          if (idx >= 0) this.queue.splice(idx, 1);
          reject(new DOMException("Task aborted", "AbortError"));
        };
        task.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.queue.push(task);
    });
  }

  private drain(): void {
    while (this.active < this.maxConcurrency && this.queue.length > 0) {
      const next = this.queue.shift()!;
      if (next.signal && next.onAbort) {
        next.signal.removeEventListener("abort", next.onAbort);
      }
      next.run();
    }
  }
}

interface PositiveEntry {
  status: "verified";
  check: Extract<TraceCheck, { status: "verified" }>;
}

interface NegativeEntry {
  status: "negative";
  check: Exclude<TraceCheck, { status: "verified" }>;
  expiresAt: number;
}

type CacheEntry = PositiveEntry | NegativeEntry;

export interface TraceVerificationCacheOptions {
  maxConcurrency?: number;
  negativeTtlMs?: number;
  now?: () => number;
}

export class TraceVerificationCache {
  readonly limiter: ConcurrencyLimiter;
  private readonly negativeTtlMs: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<TraceCheck>>();

  constructor(opts: TraceVerificationCacheOptions = {}) {
    this.limiter = new ConcurrencyLimiter(opts.maxConcurrency ?? DEFAULT_VERIFICATION_CONCURRENCY);
    this.negativeTtlMs = opts.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  static cacheKey(traceId: string, expectedHash: string): string {
    return `${traceId}:${normalizeHash(expectedHash)}`;
  }

  get(traceId: string, expectedHash: string): TraceCheck | undefined {
    const key = TraceVerificationCache.cacheKey(traceId, expectedHash);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.status === "verified") {
      // Extra defense-in-depth: never serve a cached verified result for a mismatched hash.
      if (normalizeHash(entry.check.computedHash) !== normalizeHash(expectedHash)) {
        this.entries.delete(key);
        return undefined;
      }
      return entry.check;
    }
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.check;
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }

  async verify(
    traceId: string,
    expectedHash: string,
    verifier: (signal: AbortSignal) => Promise<TraceCheck>,
    signal?: AbortSignal,
  ): Promise<TraceCheck> {
    if (signal?.aborted) {
      throw new DOMException("Verification aborted", "AbortError");
    }

    const cached = this.get(traceId, expectedHash);
    if (cached) return cached;

    const key = TraceVerificationCache.cacheKey(traceId, expectedHash);
    const existing = this.inFlight.get(key);
    if (existing) {
      if (!signal) return existing;
      return new Promise<TraceCheck>((resolve, reject) => {
        const onAbort = () => reject(new DOMException("Verification aborted", "AbortError"));
        signal.addEventListener("abort", onAbort, { once: true });
        existing.then(
          (res) => {
            signal.removeEventListener("abort", onAbort);
            resolve(res);
          },
          (err) => {
            signal.removeEventListener("abort", onAbort);
            reject(err);
          },
        );
      });
    }

    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    signal?.addEventListener("abort", onExternalAbort, { once: true });

    const promise = this.limiter
      .run(() => verifier(controller.signal), controller.signal)
      .then((check) => {
        if (check.status === "verified") {
          if (normalizeHash(check.computedHash) === normalizeHash(expectedHash)) {
            this.entries.set(key, { status: "verified", check });
          } else {
            const mismatch: TraceCheck = { status: "mismatch", computedHash: check.computedHash };
            this.entries.set(key, {
              status: "negative",
              check: mismatch,
              expiresAt: this.now() + this.negativeTtlMs,
            });
            return mismatch;
          }
        } else {
          this.entries.set(key, {
            status: "negative",
            check,
            expiresAt: this.now() + this.negativeTtlMs,
          });
        }
        return check;
      })
      .finally(() => {
        signal?.removeEventListener("abort", onExternalAbort);
        if (this.inFlight.get(key) === promise) {
          this.inFlight.delete(key);
        }
      });

    this.inFlight.set(key, promise);
    return promise;
  }
}

export const defaultTraceVerificationCache = new TraceVerificationCache();
