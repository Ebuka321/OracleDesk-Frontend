/** Minimal slice of the Web Locks API, injectable for tests. */
export interface LockManagerLike {
  request(name: string, options: { signal?: AbortSignal }, callback: () => Promise<void>): Promise<unknown>;
}

/** Messages relayed between tabs on the realtime BroadcastChannel. */
export type RelayMessage =
  | { t: "hello" }
  | { t: "status"; status: "connected" | "reconnecting" | "offline" | "unknown" }
  | { t: "event"; name: "TRADE_EXECUTED" | "REASONING_PUBLISHED"; payload: unknown };

export const REALTIME_CHANNEL = "oracledesk-realtime";
export const REALTIME_LEADER_LOCK = "oracledesk-realtime-leader";

/**
 * Run `lead` only while this tab holds the named lock. When the leader tab
 * stops (or closes, which releases the lock), the next waiting tab takes over.
 * Returns a stop function that releases leadership or leaves the queue.
 */
export function runWhileLeader(name: string, lead: () => () => void, locks: LockManagerLike): () => void {
  const abort = new AbortController();
  let release: (() => void) | null = null;
  locks.request(name, { signal: abort.signal }, () => new Promise<void>((resolve) => {
    if (abort.signal.aborted) return resolve();
    const stop = lead();
    release = () => { stop(); resolve(); };
  })).catch(() => { /* AbortError when stopped before acquiring the lock */ });
  return () => {
    abort.abort();
    release?.();
    release = null;
  };
}
