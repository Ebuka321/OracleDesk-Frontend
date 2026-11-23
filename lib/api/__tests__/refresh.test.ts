import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAuthSession, getStoredSessionId, getStoredToken, onAuthSessionChanged, replaceToken, storeAuthSession } from "../client";
import { refreshSession } from "../auth";
import { refreshDueAt, timingOf } from "../jwt-manager";

const jwt = (iat: number, exp: number) => `h.${btoa(JSON.stringify({ iat, exp }))}.s`;

describe("silent token refresh (#269)", () => {
  beforeEach(() => {
    const map = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => map.set(key, value),
      removeItem: (key: string) => map.delete(key),
    } });
    storeAuthSession({ token: "token-a", userId: "a", walletAddress: "GA" });
  });
  afterEach(() => { clearAuthSession(); vi.unstubAllGlobals(); });

  it("refresh keeps the session id and does not emit a session change", async () => {
    const sessionId = getStoredSessionId()!;
    const changed = vi.fn(); const off = onAuthSessionChanged(changed);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, data: { token: "token-b", userId: "a", walletAddress: "GA" } })));
    await expect(refreshSession({ token: "token-a", wallet: "GA", sessionId })).resolves.toBe("refreshed");
    expect(getStoredToken()).toBe("token-b");
    expect(getStoredSessionId()).toBe(sessionId);
    expect(changed).not.toHaveBeenCalled(); off();
  });

  it("discards a refreshed token after an account switch", () => {
    const sessionId = getStoredSessionId()!;
    storeAuthSession({ token: "token-c", userId: "c", walletAddress: "GC" });
    expect(replaceToken({ token: "token-b", userId: "a", walletAddress: "GA" }, sessionId)).toBe(false);
    expect(getStoredToken()).toBe("token-c");
  });

  it("refreshes before exp even when the device clock is 2h fast", () => {
    const iat = 1_000_000; const exp = iat + 7 * 24 * 3600;
    const deviceNow = iat * 1000 + 2 * 3600 * 1000;
    const due = refreshDueAt(timingOf(jwt(iat, exp), deviceNow)!);
    expect(due - deviceNow).toBeLessThan((exp - iat) * 1000);
    expect(due - deviceNow).toBeGreaterThan(0.79 * (exp - iat) * 1000);
  });
});
