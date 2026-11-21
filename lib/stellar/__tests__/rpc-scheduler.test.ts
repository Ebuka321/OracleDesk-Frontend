import { describe, expect, it, vi } from "vitest";
import {
  RpcScheduler,
  onRateLimited,
  onSuccess,
  refill,
  type BucketState,
} from "../rpc-scheduler";

function fakeClock(initial = 1_000) {
  let now = initial;
  const timers: { id: number; at: number; fn: () => void }[] = [];
  let nextId = 1;
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.push({ id, at: now + ms, fn });
      return id;
    },
    clearTimer: (id: unknown) => {
      const idx = timers.findIndex((t) => t.id === id);
      if (idx !== -1) timers.splice(idx, 1);
    },
    advance: (ms: number) => {
      now += ms;
      while (true) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > now) break;
        timers.shift();
        next.fn();
      }
    },
  };
}

describe("RpcScheduler", () => {
  it("refill/onRateLimited/onSuccess implement AIMD and honour Retry-After", () => {
    const start: BucketState = { rate: 4, burst: 8, tokens: 2, pausedUntil: 0, last: 1000 };
    const refilled = refill(start, 2000);
    expect(refilled.tokens).toBe(6);

    const limited = onRateLimited(refilled, 2000, 12_000);
    expect(limited.rate).toBe(2);
    expect(limited.tokens).toBe(0);
    expect(limited.pausedUntil).toBe(14_000);

    const floor = onRateLimited({ ...limited, rate: 0.2 }, 2000);
    expect(floor.rate).toBe(0.2);

    const recovered = onSuccess(limited, 10);
    expect(recovered.rate).toBe(2.1);
  });

  it("submit is admitted before queued background calls", async () => {
    const clock = fakeClock(10_000);
    const sched = new RpcScheduler({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      ceilings: { simulate: 2 },
    });

    const order: string[] = [];
    // Queue 200 background calls
    const bgPromises = Array.from({ length: 200 }, (_, i) =>
      sched.run("https://rpc.example", "simulateTransaction", async () => {
        order.push(`bg-${i}`);
        return i;
      }, { priority: "background", tag: "scan" }),
    );

    // Queue a submit call
    const submitPromise = sched.run(
      "https://rpc.example",
      "simulateTransaction",
      async () => {
        order.push("submit");
        return "ok";
      },
      { priority: "submit", tag: "buy" },
    );

    await expect(submitPromise).resolves.toBe("ok");
    const submitIdx = order.indexOf("submit");
    expect(submitIdx).toBeGreaterThanOrEqual(0);
    // Submit must be admitted before the remaining background calls finish
    expect(submitIdx).toBeLessThan(20);

    // Drain remaining background calls
    for (let i = 0; i < 120; i++) {
      clock.advance(1_000);
      await Promise.resolve();
    }
    await Promise.all(bgPromises);
  });

  it("background cannot take the last 25% of tokens", async () => {
    const clock = fakeClock(10_000);
    const sched = new RpcScheduler({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      ceilings: { events: 1 },
    });

    // events burst is 4 -> 25% reserve is 1, so background can only take when tokens > 1 (at most 3 calls initially)
    let ran = 0;
    const p1 = sched.run("https://rpc.example", "getEvents", async () => ++ran, { priority: "background", tag: "a" });
    const p2 = sched.run("https://rpc.example", "getEvents", async () => ++ran, { priority: "background", tag: "a" });
    const p3 = sched.run("https://rpc.example", "getEvents", async () => ++ran, { priority: "background", tag: "a" });
    const p4 = sched.run("https://rpc.example", "getEvents", async () => ++ran, { priority: "background", tag: "a" });

    await Promise.all([p1, p2, p3]);
    expect(ran).toBe(3);

    // 4th background call waits for refill, while an interactive call can take the reserved token immediately
    let interactiveRan = false;
    const pi = sched.run(
      "https://rpc.example",
      "getEvents",
      async () => {
        interactiveRan = true;
      },
      { priority: "interactive", tag: "ticket" },
    );
    await pi;
    expect(interactiveRan).toBe(true);

    clock.advance(2_500);
    await p4;
    expect(ran).toBe(4);
  });

  it("round-robin between tags within one priority", async () => {
    const clock = fakeClock(10_000);
    const sched = new RpcScheduler({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      ceilings: { meta: 1 },
    });

    // Briefly pause so all 4 calls enqueue before draining
    sched.recordRateLimited("https://rpc.example", "getHealth", 1_000);

    const order: string[] = [];
    const promises = [
      sched.run("https://rpc.example", "getHealth", async () => order.push("a1"), { priority: "normal", tag: "a" }),
      sched.run("https://rpc.example", "getHealth", async () => order.push("a2"), { priority: "normal", tag: "a" }),
      sched.run("https://rpc.example", "getHealth", async () => order.push("b1"), { priority: "normal", tag: "b" }),
      sched.run("https://rpc.example", "getHealth", async () => order.push("b2"), { priority: "normal", tag: "b" }),
    ];

    for (let i = 0; i < 12; i++) {
      clock.advance(1_000);
      await Promise.resolve();
    }
    await Promise.all(promises);
    expect(order).toEqual(["a1", "b1", "a2", "b2"]);
  });

  it("abort while queued rejects with AbortError and frees the slot", async () => {
    const clock = fakeClock(10_000);
    const sched = new RpcScheduler({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      ceilings: { events: 1 },
    });

    // Exhaust background allowance (3 tokens)
    for (let i = 0; i < 3; i++) {
      await sched.run("https://rpc.example", "getEvents", async () => i, { priority: "background", tag: "t" });
    }

    const ac = new AbortController();
    const queued = sched.run("https://rpc.example", "getEvents", async () => "never", {
      priority: "background",
      tag: "t",
      signal: ac.signal,
    });
    expect(sched.stats().priorities.background.depth).toBe(1);

    ac.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(sched.stats().priorities.background.depth).toBe(0);
  });

  it("epoch change while queued rejects with the network guard error", async () => {
    const clock = fakeClock(10_000);
    let epoch = 1;
    const sched = new RpcScheduler({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      ceilings: { events: 1 },
      getEpoch: () => epoch,
      onEpochMismatch: () => {
        throw new Error("Network changed while queued");
      },
    });

    // Exhaust background allowance
    for (let i = 0; i < 3; i++) {
      await sched.run("https://rpc.example", "getEvents", async () => i, { priority: "background", tag: "t" });
    }

    const queued = sched.run("https://rpc.example", "getEvents", async () => "never", {
      priority: "background",
      tag: "t",
    });

    epoch = 2;
    clock.advance(2_000);
    await expect(queued).rejects.toThrow("Network changed while queued");
  });

  it("getNetwork bypasses the scheduler", async () => {
    const clock = fakeClock(10_000);
    const sched = new RpcScheduler({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    sched.recordRateLimited("https://rpc.example", "getHealth", 60_000);
    const res = await sched.run("https://rpc.example", "getNetwork", async () => ({ passphrase: "test" }));
    expect(res).toEqual({ passphrase: "test" });
  });

  it("getTransaction polling continues at the floor rate while paused", async () => {
    const clock = fakeClock(10_000);
    const sched = new RpcScheduler({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    sched.recordRateLimited("https://rpc.example", "getTransaction", 30_000);

    const p1 = sched.run("https://rpc.example", "getTransaction", async () => "poll1", { priority: "submit" });
    await expect(p1).resolves.toBe("poll1");

    const calls: string[] = [];
    const p2 = sched.run(
      "https://rpc.example",
      "getTransaction",
      async () => {
        calls.push("poll2");
        return "poll2";
      },
      { priority: "submit" },
    );

    // Not yet 2s -> still queued
    expect(calls).toEqual([]);
    clock.advance(2_000);
    await expect(p2).resolves.toBe("poll2");
    expect(calls).toEqual(["poll2"]);
  });
});
