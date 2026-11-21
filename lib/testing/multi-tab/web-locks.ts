/**
 * Hand-written fake Web Locks API (`LockManager`) for deterministic multi-tab tests.
 *
 * Supports:
 *  - `exclusive` and `shared` lock modes
 *  - FIFO queueing (a queued exclusive request blocks subsequent shared requests
 *    so writers cannot starve)
 *  - `ifAvailable` option (passes `null` immediately when lock cannot be granted)
 *  - `AbortSignal` cancellation before grant (rejects with DOMException AbortError)
 *  - `query()` inspection of held and pending locks
 *  - Per-tab ownership tracking so `releaseTab(tabId)` simulates a crashed/closed tab
 *    releasing all its Web Locks immediately (matching browser behaviour).
 */

export interface FakeLock {
  readonly name: string;
  readonly mode: LockMode;
}

export interface FakeLockInfo {
  name: string;
  mode: LockMode;
  clientId: string;
}

export interface FakeLockManagerSnapshot {
  held: FakeLockInfo[];
  pending: FakeLockInfo[];
}

interface PendingRequest {
  name: string;
  mode: LockMode;
  clientId: string;
  callback: (lock: FakeLock | null) => unknown;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface HeldLock {
  name: string;
  mode: LockMode;
  clientId: string;
  release: () => void;
}

export class FakeLockManager {
  private readonly held = new Map<string, HeldLock[]>();
  private readonly pending = new Map<string, PendingRequest[]>();

  /** Creates a tab-scoped `LockManager` facade tagged with `clientId`. */
  forTab(clientId: string): LockManager {
    const manager = this;
    const request = ((
      name: string,
      optionsOrCallback: LockOptions | LockGrantedCallback,
      maybeCallback?: LockGrantedCallback,
    ): Promise<unknown> => {
      const options: LockOptions =
        typeof optionsOrCallback === "function" ? {} : (optionsOrCallback ?? {});
      const callback: LockGrantedCallback =
        typeof optionsOrCallback === "function" ? optionsOrCallback : (maybeCallback as LockGrantedCallback);
      return manager.requestForClient(clientId, name, options, callback);
    }) as LockManager["request"];

    return {
      request,
      query: async () => manager.query(),
    } as unknown as LockManager;
  }

  requestForClient<T>(
    clientId: string,
    name: string,
    options: LockOptions,
    callback: (lock: FakeLock | null) => Promise<T> | T,
  ): Promise<T> {
    const mode: LockMode = options.mode ?? "exclusive";
    const ifAvailable = Boolean(options.ifAvailable);
    const signal = options.signal;

    if (signal && ifAvailable) {
      return Promise.reject(
        new DOMException("The 'signal' and 'ifAvailable' options cannot be used together.", "NotSupportedError"),
      );
    }

    if (signal?.aborted) {
      return Promise.reject(new DOMException("The lock request was aborted.", "AbortError"));
    }

    if (ifAvailable) {
      if (this.canGrant(name, mode)) {
        return this.grantNow(clientId, name, mode, callback);
      }
      return Promise.resolve().then(() => callback(null));
    }

    if (this.canGrant(name, mode) && (this.pending.get(name)?.length ?? 0) === 0) {
      return this.grantNow(clientId, name, mode, callback);
    }

    return new Promise<T>((resolve, reject) => {
      const entry: PendingRequest = {
        name,
        mode,
        clientId,
        callback: callback as (lock: FakeLock | null) => unknown,
        resolve: resolve as (value: unknown) => void,
        reject,
        signal,
      };
      if (signal) {
        const onAbort = () => {
          const queue = this.pending.get(name);
          if (queue) {
            const idx = queue.indexOf(entry);
            if (idx >= 0) queue.splice(idx, 1);
            if (queue.length === 0) this.pending.delete(name);
          }
          reject(new DOMException("The lock request was aborted.", "AbortError"));
          this.drain(name);
        };
        entry.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }
      const queue = this.pending.get(name) ?? [];
      queue.push(entry);
      this.pending.set(name, queue);
    });
  }

  /** Simulates a tab closing or crashing: all locks held by `clientId` are released and pending requests aborted. */
  releaseTab(clientId: string): void {
    for (const [name, queue] of [...this.pending.entries()]) {
      const remaining: PendingRequest[] = [];
      for (const req of queue) {
        if (req.clientId === clientId) {
          if (req.signal && req.onAbort) req.signal.removeEventListener("abort", req.onAbort);
          req.reject(new DOMException("Tab closed while waiting for lock.", "AbortError"));
        } else {
          remaining.push(req);
        }
      }
      if (remaining.length > 0) this.pending.set(name, remaining);
      else this.pending.delete(name);
    }

    for (const [name, list] of [...this.held.entries()]) {
      const toRelease = list.filter((h) => h.clientId === clientId);
      for (const h of toRelease) h.release();
      this.drain(name);
    }
  }

  query(): FakeLockManagerSnapshot {
    const held: FakeLockInfo[] = [];
    for (const list of this.held.values()) {
      for (const item of list) {
        held.push({ name: item.name, mode: item.mode, clientId: item.clientId });
      }
    }
    const pending: FakeLockInfo[] = [];
    for (const list of this.pending.values()) {
      for (const item of list) {
        pending.push({ name: item.name, mode: item.mode, clientId: item.clientId });
      }
    }
    return { held, pending };
  }

  private canGrant(name: string, mode: LockMode): boolean {
    const list = this.held.get(name);
    if (!list || list.length === 0) return true;
    if (mode === "exclusive") return false;
    return list.every((h) => h.mode === "shared");
  }

  private grantNow<T>(
    clientId: string,
    name: string,
    mode: LockMode,
    callback: (lock: FakeLock | null) => Promise<T> | T,
  ): Promise<T> {
    let released = false;
    const heldEntry: HeldLock = {
      name,
      mode,
      clientId,
      release: () => {
        if (released) return;
        released = true;
        const list = this.held.get(name);
        if (list) {
          const idx = list.indexOf(heldEntry);
          if (idx >= 0) list.splice(idx, 1);
          if (list.length === 0) this.held.delete(name);
        }
        this.drain(name);
      },
    };
    const list = this.held.get(name) ?? [];
    list.push(heldEntry);
    this.held.set(name, list);

    const lock: FakeLock = { name, mode };
    return Promise.resolve()
      .then(() => callback(lock))
      .finally(() => {
        heldEntry.release();
      });
  }

  private drain(name: string): void {
    const queue = this.pending.get(name);
    if (!queue || queue.length === 0) return;

    while (queue.length > 0) {
      const next = queue[0];
      if (!this.canGrant(name, next.mode)) break;
      queue.shift();
      if (next.signal && next.onAbort) {
        next.signal.removeEventListener("abort", next.onAbort);
      }
      this.grantNow(next.clientId, next.name, next.mode, next.callback).then(next.resolve, next.reject);
    }

    if (queue.length === 0) this.pending.delete(name);
  }
}
