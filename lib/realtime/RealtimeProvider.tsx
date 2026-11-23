"use client";

import { createContext, useContext, useEffect, useEffectEvent, useState, type ReactNode } from "react";
import { MotionConfig } from "framer-motion";
import { io, type Socket } from "socket.io-client";
import { API_URL, SESSION_MODE, getStoredToken, notifyAuthInvalid } from "@/lib/api/client";
import { isStoredTokenExpired } from "@/lib/api/auth";
import { useUserScope, useUserScopeStore } from "@/lib/query/scope";
import { createBatcher, type Batch } from "./batch";
import {
  isCopyTradeConfirmedEvent,
  isMarketPricePayload,
  isPassExpiringEvent,
  isPaymentConfirmedEvent,
  redactPayloadForLog,
  type PassExpiringEvent,
  type PrivateRealtimeEvent,
  type RealtimeEvent,
} from "./types";
import { marketPriceStore, type ProvisionalPrice } from "./market-price-store";
import { routePrivateRealtimeEvent, type ScopeTicket } from "./private-events";
import { parseReasoningPublished, parseTradeExecuted } from "@/lib/validation/events";
import { REALTIME_CHANNEL, REALTIME_LEADER_LOCK, runWhileLeader, type RelayMessage } from "./leader";

const RELAY_EVENTS = ["TRADE_EXECUTED", "REASONING_PUBLISHED"] as const;
type RelayEventName = (typeof RELAY_EVENTS)[number];

type Listener = (batch: Batch<RealtimeEvent>) => void;
type PrivateListener = (event: PrivateRealtimeEvent, ownerWallet: string) => void;

const Context = createContext<Set<Listener> | null>(null);
const PrivateContext = createContext<Set<PrivateListener> | null>(null);
const PassExpiringContext = createContext<PassExpiringEvent | null>(null);

/** Honest socket state, surfaced so the navbar can stop guessing. */
export type SocketStatus = "connected" | "reconnecting" | "offline" | "unknown";
const StatusContext = createContext<SocketStatus>("unknown");

export type SocketFactory = (url: string, opts?: Record<string, unknown>) => Socket;

const AUTH_REJECT_CODES = new Set(["INVALID_TOKEN", "TOKEN_EXPIRED"]);

function extractConnectErrorCode(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const data = (err as { data?: unknown }).data;
  if (data && typeof data === "object" && typeof (data as { code?: unknown }).code === "string") {
    return (data as { code: string }).code;
  }
  return null;
}

export interface RealtimeProviderProps {
  children: ReactNode;
  /** Injectable socket.io client factory for tests. Defaults to `io`. */
  socketFactory?: SocketFactory;
}

export function RealtimeProvider({ children, socketFactory = io as unknown as SocketFactory }: RealtimeProviderProps) {
  const [listeners] = useState(() => new Set<Listener>());
  const [privateListeners] = useState(() => new Set<PrivateListener>());
  const [status, setStatus] = useState<SocketStatus>("unknown");
  const [passExpiring, setPassExpiring] = useState<PassExpiringEvent | null>(null);

  const scope = useUserScope();
  const scopeStore = useUserScopeStore();

  // Clear identity-scoped pass-expiring banner whenever the wallet or session changes.
  useEffect(() => {
    setPassExpiring(null);
  }, [scope.wallet, scope.sessionId]);

  useEffect(() => {
    // One scheduler for both public event kinds: mixed bursts commit once per frame.
    const batcher = createBatcher<RealtimeEvent>();
    const stop = batcher.subscribe((batch) => {
      for (const listener of listeners) listener(batch);
    });
    const visibility = () => batcher.setPaused(document.hidden);
    visibility();
    document.addEventListener("visibilitychange", visibility);

    const baseUrl = API_URL.replace(/\/api\/v1\/?$/, "");
    let disposed = false;
    let activeSocket: Socket | null = null;
    // Track whether the current connection is authenticated for this scope.
    let connectionAuthenticated = false;

    const createScopeTicket = (): ScopeTicket => {
      if (scopeStore) return scopeStore.capture(scope);
      const controller = new AbortController();
      return {
        signal: controller.signal,
        assertCurrent: () => {
          if (disposed) throw new Error("RealtimeProvider disposed");
        },
      };
    };

    const connectSocket = (allowAuth: boolean) => {
      if (disposed) return;
      if (activeSocket) {
        activeSocket.disconnect();
        activeSocket = null;
      }

      const hasSession = Boolean(scope.wallet && scope.sessionId);
      const token = allowAuth && hasSession ? getStoredToken() : null;
      const tokenUsable = Boolean(token) && !isStoredTokenExpired();
      const useCookieAuth = allowAuth && hasSession && SESSION_MODE === "cookie";
      const wantAuth = useCookieAuth || tokenUsable;

      // Never place the JWT in the URL or query string; use Socket.IO `auth.token` only.
      const opts: Record<string, unknown> = {};
      if (tokenUsable && token) {
        opts.auth = { token };
      }
      if (SESSION_MODE === "cookie") {
        opts.withCredentials = true;
      }

      const ticket = createScopeTicket();
      connectionAuthenticated = wantAuth;
      const connWallet = scope.wallet;
      const connSessionId = scope.sessionId;
      const connToken = token;

      const socket = socketFactory(baseUrl, Object.keys(opts).length > 0 ? opts : undefined);
      activeSocket = socket;

      const isCurrentConnection = () => {
        if (disposed || activeSocket !== socket) return false;
        try {
          ticket.assertCurrent();
          return true;
        } catch {
          return false;
        }
      };

      const onConnect = () => {
        if (activeSocket === socket && !disposed) setStatus("connected");
      };
      const onDisconnect = () => {
        if (activeSocket === socket && !disposed) setStatus("reconnecting");
      };
      const onReconnectAttempt = () => {
        if (activeSocket === socket && !disposed) setStatus("reconnecting");
      };
      const onConnectError = (err: unknown) => {
        if (activeSocket !== socket || disposed) return;
        const code = extractConnectErrorCode(err);
        if (wantAuth && code && AUTH_REJECT_CODES.has(code)) {
          // Backend rejected the token on handshake: flag stale session through
          // existing onAuthInvalid path and fall back to an anonymous connection
          // so public events continue without reconnect-looping on a dead token.
          connectionAuthenticated = false;
          notifyAuthInvalid(connSessionId, connToken);
          connectSocket(false);
          return;
        }
        setStatus("offline");
      };

      socket.on("connect", onConnect);
      socket.on("disconnect", onDisconnect);
      socket.on("connect_error", onConnectError);
      socket.io?.on?.("reconnect_attempt", onReconnectAttempt);

      // Public events
      socket.on("TRADE_EXECUTED", (payload: unknown) => {
        if (activeSocket !== socket || disposed) return;
        const event = parseTradeExecuted(payload);
        if (event) batcher.push({ type: "TRADE_EXECUTED", payload: event, receivedAt: Date.now() });
        else console.debug("[realtime] dropped invalid TRADE_EXECUTED payload");
      });
      socket.on("REASONING_PUBLISHED", (payload: unknown) => {
        if (activeSocket !== socket || disposed) return;
        const event = parseReasoningPublished(payload);
        if (event) batcher.push({ type: "REASONING_PUBLISHED", payload: event, receivedAt: Date.now() });
        else console.debug("[realtime] dropped invalid REASONING_PUBLISHED payload");
      });
      socket.on("MARKET_PRICE", (payload: unknown) => {
        if (activeSocket !== socket || disposed) return;
        if (isMarketPricePayload(payload)) {
          marketPriceStore.applyTick(payload);
        } else {
          console.debug("[realtime] dropped invalid MARKET_PRICE payload");
        }
      });

      // Server-side session expiry: keep socket on public events, stop trusting private events,
      // and notify existing re-login flow (do not call unused POST /auth/refresh).
      socket.on("SESSION_EXPIRED", () => {
        if (activeSocket !== socket || disposed) return;
        connectionAuthenticated = false;
        setPassExpiring(null);
        notifyAuthInvalid(connSessionId, connToken);
      });

      // Private events (attributed strictly by connection identity + scope epoch)
      const handlePrivate = (event: PrivateRealtimeEvent) => {
        if (!connectionAuthenticated || !connWallet || !isCurrentConnection()) return;
        void routePrivateRealtimeEvent(event, {
          scope,
          ticket,
          onPassExpiring: (ev) => {
            if (!isCurrentConnection()) return;
            setPassExpiring(ev.payload);
            for (const listener of privateListeners) {
              listener(ev, connWallet);
            }
          },
        });
      };

      socket.on("COPY_TRADE_CONFIRMED", (payload: unknown) => {
        if (!connectionAuthenticated || !isCurrentConnection()) return;
        if (!isCopyTradeConfirmedEvent(payload)) {
          console.warn("[realtime] dropped invalid COPY_TRADE_CONFIRMED payload", redactPayloadForLog(payload));
          return;
        }
        handlePrivate({ type: "COPY_TRADE_CONFIRMED", payload, receivedAt: Date.now() });
      });

      socket.on("PAYMENT_CONFIRMED", (payload: unknown) => {
        if (!connectionAuthenticated || !isCurrentConnection()) return;
        if (!isPaymentConfirmedEvent(payload)) {
          console.warn("[realtime] dropped invalid PAYMENT_CONFIRMED payload", redactPayloadForLog(payload));
          return;
        }
        handlePrivate({ type: "PAYMENT_CONFIRMED", payload, receivedAt: Date.now() });
      });

      socket.on("PASS_EXPIRING", (payload: unknown) => {
        if (!connectionAuthenticated || !isCurrentConnection()) return;
        if (!isPassExpiringEvent(payload)) {
          console.warn("[realtime] dropped invalid PASS_EXPIRING payload", redactPayloadForLog(payload));
          return;
        }
        handlePrivate({ type: "PASS_EXPIRING", payload, receivedAt: Date.now() });
      });
    };

    connectSocket(true);

    return () => {
      disposed = true;
      connectionAuthenticated = false;
      activeSocket?.disconnect();
      activeSocket = null;
      stop();
      batcher.dispose();
      marketPriceStore.dispose();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [listeners, privateListeners, scope, scopeStore, socketFactory]);

  return (
    <Context.Provider value={listeners}>
      <PrivateContext.Provider value={privateListeners}>
        <PassExpiringContext.Provider value={passExpiring}>
          <StatusContext.Provider value={status}>
            <MotionConfig reducedMotion="user">{children}</MotionConfig>
          </StatusContext.Provider>
        </PassExpiringContext.Provider>
      </PrivateContext.Provider>
    </Context.Provider>
  );
}

export function useRealtimeStatus(): SocketStatus {
  return useContext(StatusContext);
}

/** Latest PASS_EXPIRING hint for the currently authenticated identity, or null. */
export function usePassExpiringHint(): PassExpiringEvent | null {
  return useContext(PassExpiringContext);
}

export function usePrivateRealtimeEvents(handler: PrivateListener) {
  const listeners = useContext(PrivateContext);
  const onEvent = useEffectEvent(handler);
  useEffect(() => {
    if (!listeners) return;
    const listener: PrivateListener = (event, ownerWallet) => onEvent(event, ownerWallet);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [listeners]);
}

export function useProvisionalPrice(onChainMarketId: string | null | undefined): ProvisionalPrice | null {
  const [provisional, setProvisional] = useState<ProvisionalPrice | null>(() => {
    return onChainMarketId ? marketPriceStore.getProvisionalPrice(onChainMarketId) ?? null : null;
  });

  useEffect(() => {
    if (!onChainMarketId) {
      setProvisional(null);
      return;
    }
    setProvisional(marketPriceStore.getProvisionalPrice(onChainMarketId) ?? null);
    const unsub = marketPriceStore.subscribePrice((updated) => {
      if (updated.onChainMarketId === onChainMarketId) {
        setProvisional(updated);
      }
    });
    return unsub;
  }, [onChainMarketId]);

  return provisional;
}

export function useRealtimeBatch(handler: Listener) {
  const listeners = useContext(Context);
  const onBatch = useEffectEvent(handler);
  useEffect(() => {
    if (!listeners) throw new Error("RealtimeProvider is missing");
    const listener: Listener = (batch) => onBatch(batch);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [listeners]);
}
