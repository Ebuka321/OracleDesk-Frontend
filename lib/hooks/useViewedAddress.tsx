"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWalletAddress } from "@/lib/contexts/WalletContext";
import {
  toViewedAddress,
  validateWatchAddress,
  type ViewedAddress,
} from "@/lib/stellar/identity";

const SESSION_WATCH_KEY = "oracledesk_watch";

export interface ViewedAddressContextValue {
  /** The currently viewed address (watched address if active, else connected address). */
  viewed: ViewedAddress | null;
  /** Where the viewed address originated from: 'watch', 'connected', or null if none. */
  source: "connected" | "watch" | null;
  /** True when inspecting an address different from the connected wallet. */
  isWatching: boolean;
  /** If the address in URL or input is invalid, stores the user-facing explanation. */
  watchError: string | null;
  /** True once client-side URL/sessionStorage watch state has been resolved. */
  hydrated: boolean;
  /** Sets a new watched address, validating format and updating URL & sessionStorage. */
  setWatch: (address: string, opts?: { internal?: boolean }) => boolean;
  /** Clears the active watch, clearing sessionStorage, URL param, and relevant query caches. */
  clearWatch: () => void;
}

const ViewedAddressContext = createContext<ViewedAddressContextValue | null>(null);

function updateUrlParam(watched: string | null) {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    if (watched) {
      url.searchParams.set("watch", watched);
    } else {
      url.searchParams.delete("watch");
    }
    window.history.replaceState(null, "", url.toString());
  } catch {
    // History replace error in non-standard environment
  }
}

export function ViewedAddressProvider({ children }: { children: ReactNode }) {
  const { address: connectedAddress } = useWalletAddress();
  const queryClient = useQueryClient();

  const [watchedAddress, setWatchedAddress] = useState<ViewedAddress | null>(null);
  const [watchError, setWatchError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // Sync with URL search params / sessionStorage on mount or when popstate fires
  useEffect(() => {
    const syncFromUrl = () => {
      try {
        const urlParam = new URLSearchParams(window.location.search).get("watch");
        if (urlParam !== null) {
          const saved = window.sessionStorage.getItem(SESSION_WATCH_KEY);
          const val = validateWatchAddress(urlParam);
          if (val.ok) {
            setWatchError(null);
            if (val.address === saved) {
              setWatchedAddress(val.address);
              setPendingWatch(null);
            } else {
              // External ?watch= link: require explicit confirmation before switching
              setPendingWatch(val.address);
            }
          } else {
            setPendingWatch(null);
            setWatchError(val.error);
          }
        } else {
          const sessionParam = window.sessionStorage.getItem(SESSION_WATCH_KEY);
          if (sessionParam) {
            const val = validateWatchAddress(sessionParam);
            if (val.ok) {
              setWatchedAddress(val.address);
              setWatchError(null);
            } else {
              setWatchedAddress(null);
              window.sessionStorage.removeItem(SESSION_WATCH_KEY);
            }
          }
        }
      } catch {
        // Ignore
      }
      setHydrated(true);
    };

    syncFromUrl();
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, []);

  const clearWatch = useCallback(() => {
    const previous = watchedAddress;
    setWatchedAddress(null);
    setPendingWatch(null);
    setWatchError(null);

    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.removeItem(SESSION_WATCH_KEY);
      } catch {
        // Ignore
      }
      updateUrlParam(null);
    }

    if (previous) {
      queryClient.removeQueries({ queryKey: ["stellar", "usdcBalance", previous] });
      queryClient.removeQueries({
        predicate: (query) => {
          const k = query.queryKey;
          return Array.isArray(k) && k[0] === "stellar" && k[1] === "position" && k[3] === previous;
        },
      });
      queryClient.removeQueries({
        predicate: (query) => {
          const k = query.queryKey;
          return Array.isArray(k) && k[0] === "stellar" && k[1] === "myPositions" && k[2] === previous;
        },
      });
    }
  }, [watchedAddress, queryClient]);

  const setWatch = useCallback(
    (input: string, opts?: { internal?: boolean }): boolean => {
      void opts;
      const val = validateWatchAddress(input);
      if (!val.ok) {
        setWatchError(val.error);
        return false;
      }

      setWatchedAddress(val.address);
      setPendingWatch(null);
      setWatchError(null);

      if (typeof window !== "undefined") {
        try {
          window.sessionStorage.setItem(SESSION_WATCH_KEY, val.address);
        } catch {
          // Ignore
        }
        updateUrlParam(val.address);
      }

      return true;
    },
    [],
  );

  const confirmPendingWatch = useCallback(() => {
    if (!pendingWatch) return;
    setWatch(pendingWatch, { internal: true });
  }, [pendingWatch, setWatch]);

  const dismissPendingWatch = useCallback(() => {
    setPendingWatch(null);
    updateUrlParam(watchedAddress ?? null);
  }, [watchedAddress]);

  const connectedViewed = useMemo(
    () => toViewedAddress(connectedAddress),
    [connectedAddress],
  );

  const contextValue = useMemo<ViewedAddressContextValue>(() => {
    if (watchedAddress) {
      const isSelf = Boolean(connectedViewed && watchedAddress === connectedViewed);
      return {
        viewed: watchedAddress,
        source: isSelf ? "connected" : "watch",
        isWatching: !isSelf,
        watchError,
        hydrated,
        setWatch,
        clearWatch,
      };
    }

    if (connectedViewed) {
      return {
        viewed: connectedViewed,
        source: "connected",
        isWatching: false,
        watchError,
        hydrated,
        setWatch,
        clearWatch,
      };
    }

    return {
      viewed: null,
      source: null,
      isWatching: false,
      watchError,
      hydrated,
      setWatch,
      clearWatch,
    };
  }, [watchedAddress, connectedViewed, watchError, hydrated, setWatch, clearWatch]);

  return (
    <ViewedAddressContext.Provider value={contextValue}>
      {children}
    </ViewedAddressContext.Provider>
  );
}

/**
 * Accesses the currently viewed address, whether in watch mode, and controls to
 * set or clear the watched address.
 */
export function useViewedAddress(): ViewedAddressContextValue {
  const ctx = useContext(ViewedAddressContext);
  if (!ctx) {
    throw new Error("useViewedAddress must be used within <ViewedAddressProvider>");
  }
  return ctx;
}
