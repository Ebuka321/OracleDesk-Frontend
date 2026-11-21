import { solveSteps } from "./pow";
import type { PowWorkerInMessage, PowWorkerOutMessage } from "./pow.worker";

export interface PowRunnerOptions {
  account: string;
  salt: string;
  bits: number;
  signal?: AbortSignal;
  onProgress?: (progress: { tried: number; estimatedProgress: number; bits: number }) => void;
}

let nextJobId = 0;

/**
 * Calculates estimated completion percentage based on Poisson probability:
 * 1 - e^(-tried / 2^bits)
 */
export function estimatePowProgress(tried: number, bits: number): number {
  if (bits <= 0) return 1;
  const expected = 2 ** bits;
  const progress = 1 - Math.exp(-tried / expected);
  return Math.min(0.99, Math.max(0, progress));
}

export async function solvePow(opts: PowRunnerOptions): Promise<string> {
  const { account, salt, bits, signal, onProgress } = opts;
  if (signal?.aborted) throw new Error("PoW solve aborted");

  // Track tab hidden duration to abort if hidden > 30s
  let hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  const localController = new AbortController();
  const combinedSignal = signal;

  const handleVisibility = () => {
    if (typeof document === "undefined") return;
    if (document.visibilityState === "hidden") {
      hiddenTimer = setTimeout(() => {
        localController.abort();
      }, 30_000);
    } else {
      if (hiddenTimer) {
        clearTimeout(hiddenTimer);
        hiddenTimer = null;
      }
    }
  };

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", handleVisibility);
  }

  const cleanupVisibility = () => {
    if (hiddenTimer) clearTimeout(hiddenTimer);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", handleVisibility);
    }
  };

  const isAborted = () => signal?.aborted || localController.signal.aborted;

  // Try Worker first if supported
  if (typeof Worker !== "undefined" && typeof window !== "undefined") {
    try {
      const result = await solveWithWorkers({
        account,
        salt,
        bits,
        isAborted,
        signal,
        onProgress: (tried) => {
          onProgress?.({
            tried,
            estimatedProgress: estimatePowProgress(tried, bits),
            bits,
          });
        },
      });
      cleanupVisibility();
      return result;
    } catch {
      // Fallback to main-thread solver on worker failure or CSP block
    }
  }

  try {
    const result = await solveOnMainThread({
      account,
      salt,
      bits,
      isAborted,
      signal,
      onProgress: (tried) => {
        onProgress?.({
          tried,
          estimatedProgress: estimatePowProgress(tried, bits),
          bits,
        });
      },
    });
    cleanupVisibility();
    return result;
  } finally {
    cleanupVisibility();
  }
}

async function solveWithWorkers(opts: {
  account: string;
  salt: string;
  bits: number;
  isAborted: () => boolean;
  signal?: AbortSignal;
  onProgress?: (tried: number) => void;
}): Promise<string> {
  const { account, salt, bits, isAborted, signal, onProgress } = opts;
  const numWorkers = typeof navigator !== "undefined" && (navigator.hardwareConcurrency ?? 1) >= 4 ? 2 : 1;
  const workers: Worker[] = [];
  const jobId = `pow_${++nextJobId}_${Date.now()}`;

  let totalTried = 0;
  const triedByWorker: number[] = new Array(numWorkers).fill(0);

  return new Promise<string>((resolve, reject) => {
    let resolved = false;

    const terminateAll = () => {
      resolved = true;
      workers.forEach((w, idx) => {
        try {
          w.postMessage({ type: "cancel", id: `${jobId}_${idx}` } satisfies PowWorkerInMessage);
          w.terminate();
        } catch {
          // ignore termination errors
        }
      });
    };

    const abortHandler = () => {
      terminateAll();
      reject(new Error("PoW solve aborted"));
    };

    if (signal) {
      signal.addEventListener("abort", abortHandler, { once: true });
    }

    try {
      for (let i = 0; i < numWorkers; i++) {
        const worker = new Worker(new URL("./pow.worker.ts", import.meta.url), { type: "module" });
        workers.push(worker);

        // Disjoint starting nonce offset per worker
        const startOffset = BigInt(Math.floor(Math.random() * 0x7fffffffffff)) + BigInt(i) * 0x10000000000n;

        worker.onmessage = (e: MessageEvent<PowWorkerOutMessage>) => {
          if (resolved || isAborted()) return;
          const msg = e.data;
          if (msg.type === "progress") {
            triedByWorker[i] = msg.tried;
            totalTried = triedByWorker.reduce((sum, v) => sum + v, 0);
            onProgress?.(totalTried);
          } else if (msg.type === "solved") {
            terminateAll();
            if (signal) signal.removeEventListener("abort", abortHandler);
            resolve(msg.nonce);
          }
        };

        worker.onerror = (err) => {
          if (!resolved) {
            terminateAll();
            if (signal) signal.removeEventListener("abort", abortHandler);
            reject(err);
          }
        };

        worker.postMessage({
          type: "solve",
          id: `${jobId}_${i}`,
          account,
          salt,
          bits,
          startNonce: startOffset.toString(),
        } satisfies PowWorkerInMessage);
      }
    } catch (err) {
      terminateAll();
      if (signal) signal.removeEventListener("abort", abortHandler);
      throw err;
    }
  });
}

async function solveOnMainThread(opts: {
  account: string;
  salt: string;
  bits: number;
  isAborted: () => boolean;
  signal?: AbortSignal;
  onProgress?: (tried: number) => void;
}): Promise<string> {
  const { account, salt, bits, isAborted, signal, onProgress } = opts;
  const generator = solveSteps({
    account,
    salt,
    bits,
    batch: 2000,
    signal,
  });

  while (!isAborted()) {
    const res = generator.next();
    if (res.done) break;

    const value = res.value;
    if ("nonce" in value) {
      return value.nonce;
    }

    onProgress?.(value.tried);

    // Yield control to event loop to avoid blocking main thread (> 50ms)
    if (typeof (globalThis as unknown as { scheduler?: { yield?: () => Promise<void> } }).scheduler?.yield === "function") {
      await (globalThis as unknown as { scheduler: { yield: () => Promise<void> } }).scheduler.yield();
    } else {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  throw new Error("PoW solve aborted");
}
