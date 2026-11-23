import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { rpc } from "@stellar/stellar-sdk";
import { rpcServer, withPinnedRpc, rpcPool } from "../clients";
import { scheduler, withRpcPriority } from "../rpc-scheduler";

describe("rpcServer scheduler integration", () => {
  const origWindow = globalThis.window;

  beforeEach(() => {
    // Ensure clients.ts treats this as a browser environment so scheduler & pool are active
    (globalThis as unknown as { window: unknown }).window = {};
  });

  afterEach(() => {
    (globalThis as unknown as { window: unknown }).window = origWindow;
    vi.restoreAllMocks();
  });

  it("routes simulateTransaction, getEvents and sendTransaction through scheduler.run with expected priority", async () => {
    const runSpy = vi.spyOn(scheduler(), "run");
    const server = rpcServer("https://mock-rpc-1.example");

    vi.spyOn(rpc.Server.prototype, "simulateTransaction").mockResolvedValue({ id: "sim" } as never);
    vi.spyOn(rpc.Server.prototype, "getEvents").mockResolvedValue({ events: [] } as never);
    vi.spyOn(rpc.Server.prototype, "sendTransaction").mockResolvedValue({ status: "PENDING" } as never);

    await withRpcPriority({ priority: "interactive", tag: "quote" }, () =>
      server.simulateTransaction({} as never),
    );
    expect(runSpy).toHaveBeenLastCalledWith(
      "https://mock-rpc-1.example",
      "simulateTransaction",
      expect.any(Function),
      expect.objectContaining({ priority: "interactive", tag: "quote" }),
    );

    await withRpcPriority({ priority: "background", tag: "events" }, () =>
      server.getEvents({} as never),
    );
    expect(runSpy).toHaveBeenLastCalledWith(
      "https://mock-rpc-1.example",
      "getEvents",
      expect.any(Function),
      expect.objectContaining({ priority: "background", tag: "events" }),
    );

    await withPinnedRpc(async () => {
      await server.sendTransaction({} as never);
    });
    expect(runSpy).toHaveBeenLastCalledWith(
      expect.any(String),
      "sendTransaction",
      expect.any(Function),
      expect.objectContaining({ priority: "submit" }),
    );
  });

  it("records 429s with Retry-After into the pool", async () => {
    const server = rpcServer("https://mock-rpc-2.example");
    const err429 = Object.assign(new Error("Request failed with status 429"), {
      response: { status: 429, headers: { "retry-after": "12" } },
    });
    vi.spyOn(rpc.Server.prototype, "getHealth").mockRejectedValue(err429);

    const pool = rpcPool();
    const recordSpy = pool ? vi.spyOn(pool, "record") : null;

    await expect(server.getHealth()).rejects.toThrow("429");
    if (recordSpy) {
      expect(recordSpy).toHaveBeenCalledWith(
        "https://mock-rpc-2.example",
        expect.objectContaining({ status: 429, retryAfterS: 12 }),
      );
    }
  });
});
