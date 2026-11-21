import { describe, it, expect, vi, beforeEach } from "vitest";
import { registerStore, storageStatus, requestPersistence, ensureHeadroom, assertDurableStorage, StorageUnavailableError } from "../quota";

function mockNavigatorStorage(opts: { persisted?: boolean; usage?: number; quota?: number; persistResult?: boolean }) {
  const { persisted = false, usage = 1024, quota = 10 * 1024 * 1024, persistResult = true } = opts;
  Object.defineProperty(navigator, "storage", {
    configurable: true,
    value: {
      persisted: vi.fn().mockResolvedValue(persisted),
      persist: vi.fn().mockResolvedValue(persistResult),
      estimate: vi.fn().mockResolvedValue({ usage, quota }),
    },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("registerStore / storageStatus", () => {
  it("includes registered stores in status", async () => {
    mockNavigatorStorage({ persisted: false, usage: 500, quota: 10000 });
    const unregister = registerStore({
      id: "test-store",
      cls: "disposable",
      estimateBytes: async () => 42,
    });

    const status = await storageStatus();
    expect(status.stores.find((s) => s.id === "test-store")).toMatchObject({ id: "test-store", cls: "disposable", bytes: 42 });
    unregister();
  });
});

describe("evicts disposable stores in priority order until headroom is met", () => {
  it("calls evict on disposable stores, never on evidence", async () => {
    mockNavigatorStorage({ usage: 9 * 1024 * 1024, quota: 10 * 1024 * 1024 });
    const evidenceEvict = vi.fn();
    const disposableEvict = vi.fn().mockResolvedValue(6 * 1024 * 1024);
    const u1 = registerStore({ id: "ev-store", cls: "evidence", estimateBytes: async () => 100, evict: evidenceEvict });
    const u2 = registerStore({ id: "dis-store", cls: "disposable", estimateBytes: async () => 100, evict: disposableEvict });
    await ensureHeadroom(5 * 1024 * 1024);
    expect(evidenceEvict).not.toHaveBeenCalled();
    expect(disposableEvict).toHaveBeenCalled();
    u1(); u2();
  });
});

describe("requestPersistence", () => {
  it("is rate limited to once per 7 days and records outcome", async () => {
    mockNavigatorStorage({ persistResult: true });
    const result1 = await requestPersistence("payment");
    expect(result1.granted).toBe(true);
    // Second call within 7 days returns cached
    const result2 = await requestPersistence("payment");
    expect(result2.askedAt).toBe(result1.askedAt);
  });
});

describe("assertDurableStorage", () => {
  it("refuses when probe write throws QuotaExceededError", async () => {
    mockNavigatorStorage({ persisted: true, usage: 1024, quota: 100 * 1024 * 1024 });
    const setItemMock = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      const err = new DOMException("quota exceeded", "QuotaExceededError");
      throw err;
    });
    await expect(assertDurableStorage("x402")).rejects.toThrow(StorageUnavailableError);
    setItemMock.mockRestore();
  });

  it("resolves when storage is available", async () => {
    mockNavigatorStorage({ persisted: true, usage: 1024, quota: 100 * 1024 * 1024 });
    await expect(assertDurableStorage("x402")).resolves.toBeUndefined();
  });
});
