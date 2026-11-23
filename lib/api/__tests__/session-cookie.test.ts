import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Client = typeof import("../client");
type Auth = typeof import("../auth");

function stubStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => map.set(key, value),
      removeItem: (key: string) => map.delete(key),
    },
  });
  return map;
}

async function cookieModules(): Promise<{ client: Client; auth: Auth }> {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_SESSION_MODE", "cookie");
  vi.stubEnv("NODE_ENV", "development");
  return { client: await import("../client"), auth: await import("../auth") };
}

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("cookie session mode", () => {
  it("uses credentials include, sends CSRF on writes and never an Authorization header", async () => {
    stubStorage();
    const { client } = await cookieModules();
    expect(client.SESSION_MODE).toBe("cookie");
    client.setCsrfToken("csrf-1");
    const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true, data: {} }));
    vi.stubGlobal("fetch", fetch);

    await client.apiClient.get("/traces/t1");
    await client.apiClient.post("/traces/access/allowance", { dailyLimit: 1 });

    const [getInit, postInit] = [fetch.mock.calls[0][1], fetch.mock.calls[1][1]];
    expect(getInit.credentials).toBe("include");
    expect(postInit.credentials).toBe("include");
    expect(new Headers(getInit.headers).get("X-CSRF-Token")).toBeNull();
    expect(new Headers(postInit.headers).get("X-CSRF-Token")).toBe("csrf-1");
    expect(new Headers(postInit.headers).get("Authorization")).toBeNull();
  });

  it("stores only the wallet hint, never a token or user id", async () => {
    const storage = stubStorage();
    const { client } = await cookieModules();
    client.storeAuthSession({ token: "jwt-value", userId: "u1", walletAddress: "GA", csrfToken: "csrf-2" });
    expect(storage.get("oracledesk_token")).toBeUndefined();
    expect(storage.get("oracledesk_user_id")).toBeUndefined();
    expect(storage.get("oracledesk_wallet")).toBe("GA");
    expect(client.getStoredSessionWallet()).toBe("GA");
    expect(client.getCsrfToken()).toBe("csrf-2");
    client.clearAuthSession();
    expect(client.getStoredSessionWallet()).toBeNull();
  });

  it("reads the session wallet from GET /auth/session and maps 401 to null", async () => {
    stubStorage();
    const { auth } = await cookieModules();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: true, data: { walletAddress: "GB", userId: "u2" } })));
    await expect(auth.getSession()).resolves.toMatchObject({ walletAddress: "GB" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ok: false, error: { code: "UNAUTHORIZED", message: "No session" } }, { status: 401 })));
    await expect(auth.getSession()).resolves.toBeNull();
  });

  it("migrates a legacy token once and deletes the old keys", async () => {
    const storage = stubStorage({ oracledesk_token: "legacy-jwt", oracledesk_user_id: "u1" });
    const { auth, client } = await cookieModules();
    const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true, data: { walletAddress: "GC", csrfToken: "csrf-3" } }));
    vi.stubGlobal("fetch", fetch);

    await auth.migrateLegacySession();
    await auth.migrateLegacySession();

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toContain("/auth/upgrade");
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe("Bearer legacy-jwt");
    expect(storage.get("oracledesk_token")).toBeUndefined();
    expect(storage.get("oracledesk_user_id")).toBeUndefined();
    expect(storage.get("oracledesk_cookie_upgraded")).toBe("1");
    expect(client.getStoredSessionWallet()).toBe("GC");
    expect(client.getCsrfToken()).toBe("csrf-3");
  });

  it("discards a dead legacy token on 401 without looping", async () => {
    const storage = stubStorage({ oracledesk_token: "dead-jwt", oracledesk_user_id: "u1" });
    const { auth } = await cookieModules();
    const fetch = vi.fn().mockResolvedValue(Response.json({ ok: false, error: { code: "INVALID_TOKEN", message: "dead" } }, { status: 401 }));
    vi.stubGlobal("fetch", fetch);

    await auth.migrateLegacySession();
    await auth.migrateLegacySession();
    expect(fetch).toHaveBeenCalledOnce();
    expect(storage.get("oracledesk_token")).toBeUndefined();
  });

  it("keeps the legacy token when the migration request fails offline", async () => {
    const storage = stubStorage({ oracledesk_token: "legacy-jwt" });
    const { auth } = await cookieModules();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await auth.migrateLegacySession();
    expect(storage.get("oracledesk_token")).toBe("legacy-jwt");
  });

  it("serializes logout before a new sign-in", async () => {
    stubStorage();
    const { auth } = await cookieModules();
    let release!: () => void;
    let calls = 0;
    const fetch = vi.fn().mockImplementation(() => {
      calls += 1;
      if (calls === 1) return new Promise<Response>((resolve) => { release = () => resolve(Response.json({ ok: true, data: {} })); });
      return Promise.resolve(Response.json({ ok: true, data: { transaction: "invalid", networkPassphrase: "x", expiresAt: "later" } }));
    });
    vi.stubGlobal("fetch", fetch);
    const logout = auth.logout();
    const signIn = auth.signInWithWallet("GA", vi.fn());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch).toHaveBeenCalledTimes(1);
    release();
    await logout;
    await signIn.catch(() => undefined);
    expect(fetch.mock.calls[0][0]).toContain("/auth/logout");
    expect(fetch.mock.calls[1][0]).toContain("/auth/challenge");
  });
});
