import React from "react";
import { act, render } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io-client";
import { UserScopeContext, UserScopeStore } from "@/lib/query/scope";
import { clearAuthSession, onAuthInvalid, storeAuthSession } from "@/lib/api/client";
import {
  RealtimeProvider,
  usePassExpiringHint,
  useRealtimeBatch,
  type SocketFactory,
} from "../RealtimeProvider";
import type { RealtimeEvent } from "../types";

const WALLET_A = "GCM7WU3RADBCIKBLGPPAEYV5WHASWMEQX6BU524QR3QFWSE7BIWCXAIF";
const WALLET_B = "GB7TAYRUZGE6TVT7NHP5SMIZRNQA6PLM423EYISAOAP3MKYIQMVYP2JO";

function makeJwt(expSeconds: number): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = btoa(JSON.stringify({ sub: "user-1", exp: expSeconds }));
  return `${header}.${payload}.sig`;
}

interface FakeSocketInstance {
  url: string;
  opts?: Record<string, unknown>;
  disconnected: boolean;
  emitServer(event: string, ...args: unknown[]): void;
  socket: Socket;
}

function createFakeSocketFactory() {
  const created: FakeSocketInstance[] = [];
  const factory: SocketFactory = (url, opts) => {
    const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
    const ioHandlers = new Map<string, Set<(...args: unknown[]) => void>>();
    const instance: FakeSocketInstance = {
      url,
      opts,
      disconnected: false,
      emitServer(event, ...args) {
        for (const fn of handlers.get(event) ?? []) fn(...args);
      },
      socket: {
        on(event: string, fn: (...args: unknown[]) => void) {
          let set = handlers.get(event);
          if (!set) {
            set = new Set();
            handlers.set(event, set);
          }
          set.add(fn);
          return this;
        },
        disconnect() {
          instance.disconnected = true;
          return this;
        },
        io: {
          on(event: string, fn: (...args: unknown[]) => void) {
            let set = ioHandlers.get(event);
            if (!set) {
              set = new Set();
              ioHandlers.set(event, set);
            }
            set.add(fn);
            return this;
          },
        },
      } as unknown as Socket,
    };
    created.push(instance);
    return instance.socket;
  };
  return { factory, created };
}

describe("RealtimeProvider authentication & private events (Issue #242)", () => {
  let store: UserScopeStore;

  beforeEach(() => {
    localStorage.clear();
    clearAuthSession();
    store = new UserScopeStore(new QueryClient());
  });

  afterEach(() => {
    clearAuthSession();
    vi.restoreAllMocks();
  });

  it("sends JWT in auth.token (never in URL/query) and drops late private events after identity change", () => {
    const validToken = makeJwt(Math.floor(Date.now() / 1000) + 3600);
    storeAuthSession({ token: validToken, userId: "u1", walletAddress: WALLET_A });
    store.resetUserScope({ wallet: WALLET_A, sessionId: "sess-a" }, "signed-in");

    const { factory, created } = createFakeSocketFactory();
    let seenHint: unknown = null;
    function Consumer() {
      seenHint = usePassExpiringHint();
      return null;
    }

    render(
      <UserScopeContext.Provider value={store}>
        <RealtimeProvider socketFactory={factory}>
          <Consumer />
        </RealtimeProvider>
      </UserScopeContext.Provider>,
    );

    expect(created).toHaveLength(1);
    expect(created[0].url).not.toContain(validToken);
    expect(created[0].url).not.toContain("token=");
    expect(created[0].opts?.auth).toEqual({ token: validToken });

    // Switch identity to WALLET_B: old socket disconnects and new connection opens
    act(() => {
      store.resetUserScope({ wallet: WALLET_B, sessionId: null }, "account-change");
    });
    expect(created[0].disconnected).toBe(true);
    expect(created).toHaveLength(2);
    expect(created[1].opts?.auth).toBeUndefined();

    // A late PASS_EXPIRING on the old socket is ignored
    act(() => {
      created[0].emitServer("PASS_EXPIRING", { expiresAt: "2026-10-21T10:00:00Z" });
    });
    expect(seenHint).toBeNull();
  });

  it("falls back to anonymous on INVALID_TOKEN/TOKEN_EXPIRED connect_error and keeps public events flowing", () => {
    const validToken = makeJwt(Math.floor(Date.now() / 1000) + 3600);
    storeAuthSession({ token: validToken, userId: "u1", walletAddress: WALLET_A });
    store.resetUserScope({ wallet: WALLET_A, sessionId: "sess-a" }, "signed-in");

    const invalidSpy = vi.fn();
    const off = onAuthInvalid(invalidSpy);

    const { factory, created } = createFakeSocketFactory();
    const batches: RealtimeEvent[][] = [];
    function Consumer() {
      useRealtimeBatch((batch) => batches.push([...batch]));
      return null;
    }

    render(
      <UserScopeContext.Provider value={store}>
        <RealtimeProvider socketFactory={factory}>
          <Consumer />
        </RealtimeProvider>
      </UserScopeContext.Provider>,
    );

    expect(created).toHaveLength(1);
    act(() => {
      created[0].emitServer("connect_error", { message: "bad token", data: { code: "TOKEN_EXPIRED" } });
    });

    expect(invalidSpy).toHaveBeenCalledTimes(1);
    expect(created[0].disconnected).toBe(true);
    // Fallback anonymous connection opened with no auth.token
    expect(created).toHaveLength(2);
    expect(created[1].opts?.auth).toBeUndefined();
    off();
  });

  it("handles SESSION_EXPIRED by flagging auth invalid, rejecting further private events, and keeping public connection", () => {
    const validToken = makeJwt(Math.floor(Date.now() / 1000) + 3600);
    storeAuthSession({ token: validToken, userId: "u1", walletAddress: WALLET_A });
    store.resetUserScope({ wallet: WALLET_A, sessionId: "sess-a" }, "signed-in");

    const invalidSpy = vi.fn();
    const off = onAuthInvalid(invalidSpy);
    const { factory, created } = createFakeSocketFactory();
    let seenHint: unknown = null;
    function Consumer() {
      seenHint = usePassExpiringHint();
      return null;
    }

    render(
      <UserScopeContext.Provider value={store}>
        <RealtimeProvider socketFactory={factory}>
          <Consumer />
        </RealtimeProvider>
      </UserScopeContext.Provider>,
    );

    act(() => {
      created[0].emitServer("SESSION_EXPIRED");
    });
    expect(invalidSpy).toHaveBeenCalledTimes(1);
    expect(created[0].disconnected).toBe(false);

    // Private event after SESSION_EXPIRED must be dropped
    act(() => {
      created[0].emitServer("PASS_EXPIRING", { expiresAt: "2026-10-21T10:00:00Z" });
    });
    expect(seenHint).toBeNull();
    off();
  });

  it("drops invalid private payloads with a redacted warning", () => {
    const validToken = makeJwt(Math.floor(Date.now() / 1000) + 3600);
    storeAuthSession({ token: validToken, userId: "u1", walletAddress: WALLET_A });
    store.resetUserScope({ wallet: WALLET_A, sessionId: "sess-a" }, "signed-in");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { factory, created } = createFakeSocketFactory();

    render(
      <UserScopeContext.Provider value={store}>
        <RealtimeProvider socketFactory={factory}>
          <div />
        </RealtimeProvider>
      </UserScopeContext.Provider>,
    );

    act(() => {
      created[0].emitServer("COPY_TRADE_CONFIRMED", { copyTradeId: 999, secret: "do-not-log" });
      created[0].emitServer("PAYMENT_CONFIRMED", { txHash: "bad", status: "NOPE" });
      created[0].emitServer("PASS_EXPIRING", { expiresAt: "invalid" });
    });

    expect(warnSpy).toHaveBeenCalledTimes(3);
    for (const call of warnSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("do-not-log");
    }
  });
});
