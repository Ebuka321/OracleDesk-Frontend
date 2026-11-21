"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { registerWorker } from "@/lib/pwa/register";
import { UpdatePendingContext } from "@/lib/pwa/update-context";

export const LAST_URL_KEY = "oracledesk_last_url";

export interface PrecacheFailure {
  url: string;
  expected?: string;
  actual?: string;
  expectedSize?: number;
  actualSize?: number;
  reason?: string;
}

export interface VerificationErrorReport {
  buildId: string;
  failures: PrecacheFailure[];
  message?: string;
}

/**
 * Registers the service worker (production, secure origins only) and owns
 * the update flow: when a new worker is waiting, a non-dismissable banner
 * asks the user to reload, and signing is blocked until they do.
 * If verification fails during install, the worker is rejected and diagnostics are shown.
 */
export function PwaRegistrar({ children }: { children: ReactNode }) {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const [installFailed, setInstallFailed] = useState(false);
  const [verificationError, setVerificationError] = useState<VerificationErrorReport | null>(null);
  const latestErrorRef = useRef<VerificationErrorReport | null>(null);
  const reloading = useRef(false);
  const pathname = usePathname();

  // Remember where the user was, for the offline page's "Try again".
  useEffect(() => {
    if (pathname === "/offline") return;
    try {
      window.sessionStorage.setItem(LAST_URL_KEY, `${pathname}${window.location.search}`);
    } catch {
      // storage blocked
    }
  }, [pathname]);

  useEffect(() => {
    let cancelled = false;
    let reg: ServiceWorkerRegistration | null = null;

    const onMessage = (event: MessageEvent) => {
      if (event.data && event.data.type === "PRECACHE_VERIFICATION_FAILED") {
        const report: VerificationErrorReport = {
          buildId: event.data.buildId,
          failures: event.data.failures ?? [],
          message: event.data.message,
        };
        latestErrorRef.current = report;
        setVerificationError(report);
        setInstallFailed(true);
        console.error("[pwa] precache verification failed for incoming service worker update:", report);
      }
    };

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", onMessage);
    }

    const track = (r: ServiceWorkerRegistration) => {
      // Only a waiting worker *while another controls the page* is an update.
      if (r.waiting && navigator.serviceWorker.controller) {
        setWaiting(r.waiting);
      }
      r.addEventListener("updatefound", () => {
        const sw = r.installing;
        sw?.addEventListener("statechange", () => {
          if (cancelled) return;
          if (sw.state === "installed" && navigator.serviceWorker.controller) {
            // Good update installed and waiting
            setWaiting(r.waiting ?? sw);
            setInstallFailed(false);
          } else if (sw.state === "redundant") {
            // Worker was discarded during install (failed verification or install error)
            setWaiting(null);
            setInstallFailed(true);
            console.error(
              "[pwa] service worker update failed during install (worker became redundant)",
              latestErrorRef.current
            );
          }
        });
      });
    };

    registerWorker()
      .then((r) => {
        if (!r || cancelled) return;
        reg = r;
        track(r);
      })
      .catch((err) => console.warn("[pwa] service worker registration failed", err));

    const onControllerChange = () => {
      if (reloading.current) return;
      reloading.current = true;
      window.location.reload();
    };
    if ("serviceWorker" in navigator) navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    // Look for a new deployment when the tab comes back.
    const onVisible = () => document.visibilityState === "visible" && void reg?.update().catch(() => {});
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if ("serviceWorker" in navigator) {
        navigator.serviceWorker.removeEventListener("message", onMessage);
        navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      }
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return (
    <UpdatePendingContext.Provider value={waiting !== null}>
      {installFailed && !waiting && (
        <div
          role="alert"
          className="fixed bottom-0 inset-x-0 z-[100] bg-red-700 text-white px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-sm shadow-xl"
        >
          <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3">
            <span className="font-bold tracking-wide uppercase text-xs bg-red-900/60 px-2 py-0.5 rounded">
              Update Integrity Failure
            </span>
            <span>A service worker update failed integrity verification. The active version remains running for safety.</span>
            {verificationError?.failures && verificationError.failures.length > 0 && (
              <span className="text-xs font-mono opacity-90">
                ({verificationError.failures.length} asset mismatch: {verificationError.failures[0].url})
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => setInstallFailed(false)}
            className="px-3 py-1 bg-white/20 hover:bg-white/30 rounded text-xs uppercase font-bold tracking-wider shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}
      {waiting && (
        <div role="alert" className="fixed bottom-0 inset-x-0 z-[100] bg-primary text-white px-4 py-3 flex flex-wrap items-center justify-center gap-3 text-sm">
          <span>A new version of OracleDesk is available. Reload to update.</span>
          <button
            type="button"
            onClick={() => waiting.postMessage({ type: "SKIP_WAITING" })}
            className="px-4 py-1.5 bg-white text-primary rounded-md font-bold"
          >
            Reload
          </button>
        </div>
      )}
      {children}
    </UpdatePendingContext.Provider>
  );
}
