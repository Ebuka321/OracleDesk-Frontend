import { describe, expect, it, vi } from "vitest";
import { runWhileLeader, type LockManagerLike } from "../leader";

/** Exclusive in-memory lock: one holder, FIFO waiters, abort removes a waiter. */
function fakeLocks(): LockManagerLike {
  let held = false;
  const queue: { run: () => Promise<void>; signal?: AbortSignal }[] = [];
  const next = () => {
    while (!held && queue.length) {
      const waiter = queue.shift()!;
      if (waiter.signal?.aborted) continue;
      held = true;
      void waiter.run().finally(() => { held = false; next(); });
    }
  };
  return {
    request(_name, options, callback) {
      queue.push({ run: callback, signal: options.signal });
      next();
      return Promise.resolve();
    },
  };
}

describe("runWhileLeader", () => {
  it("elects one leader and hands off when it stops", async () => {
    const locks = fakeLocks();
    const closeA = vi.fn(), closeB = vi.fn();
    const leadA = vi.fn(() => closeA), leadB = vi.fn(() => closeB);
    const stopA = runWhileLeader("lock", leadA, locks);
    const stopB = runWhileLeader("lock", leadB, locks);
    expect(leadA).toHaveBeenCalledOnce();
    expect(leadB).not.toHaveBeenCalled();

    stopA();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closeA).toHaveBeenCalledOnce();
    expect(leadB).toHaveBeenCalledOnce();

    stopB();
    expect(closeB).toHaveBeenCalledOnce();
  });

  it("never leads after stopping while still waiting", async () => {
    const locks = fakeLocks();
    const stopA = runWhileLeader("lock", () => () => {}, locks);
    const leadB = vi.fn(() => () => {});
    const stopB = runWhileLeader("lock", leadB, locks);
    stopB();
    stopA();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(leadB).not.toHaveBeenCalled();
  });
});
