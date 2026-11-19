"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { NETWORK_LABEL } from "@/lib/stellar/config";
import {
  addBreadcrumb,
  getReportingConsent,
  hasReportingConsentChoice,
  initReporting,
  isReportingConfigured,
  reportError,
  reportMessage,
  setCurrentRoute,
  setConsentPromptHandler,
  setReportingConsent,
} from "@/lib/observability/report";
import { initTracing } from "@/lib/observability/tracing";

/**
 * Mounts the error-reporting runtime (issue #123): initialises reporting
 * when NEXT_PUBLIC_ERROR_REPORTING_DSN is set, registers window error and
 * unhandledrejection handlers (filtering browser-extension frames and
 * ResizeObserver noise), breadcrumbs route changes, and shows a small,
 * dismissible consent prompt on the first error when no choice is stored.
 */
export function ErrorReportingInit() {
  const pathname = usePathname();
  const [promptVisible, setPromptVisible] = useState(false);

  // Init + global handlers once per mount.
  useEffect(() => {
    initTracing(); // issue #124: no-op unless NEXT_PUBLIC_OTEL_EXPORTER_URL is set
    if (isReportingConfigured()) {
      initReporting({
        dsn: process.env.NEXT_PUBLIC_ERROR_REPORTING_DSN ?? "",
        release: process.env.NEXT_PUBLIC_BUILD_SHA ?? "dev",
        environment: NETWORK_LABEL,
      });
    }

    const onWindowError = (event: ErrorEvent) => {
      const target = event.target as { src?: unknown; href?: unknown } | null;
      // Resource load failures (img/script) carry no useful stack; skip them.
      if (target && typeof target === "object" && ("src" in target || "href" in target)) return;
      const message = String(event.message ?? "");
      if (message.includes("ResizeObserver loop")) return; // benign, endless otherwise
      if (event.error) reportError(event.error);
      else if (message) reportMessage("error", message);
    };

    const onRejection = (event: PromiseRejectionEvent) => {
      const reason: unknown = event.reason;
      const message = reason instanceof Error ? reason.message : String(reason ?? "Unhandled promise rejection");
      if (message.includes("ResizeObserver loop")) return;
      reportError(reason instanceof Error ? reason : new Error(message));
    };

    window.addEventListener("error", onWindowError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onWindowError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  // Route breadcrumb (pathname only — no query strings).
  useEffect(() => {
    setCurrentRoute(pathname);
    addBreadcrumb("route", pathname);
  }, [pathname]);

  // First-error consent prompt.
  useEffect(() => {
    setConsentPromptHandler(() => setPromptVisible(true));
    return () => setConsentPromptHandler(null);
  }, []);

  if (!promptVisible || getReportingConsent() || hasReportingConsentChoice()) return null;

  return (
    <div
      role="region"
      aria-label="Error report consent"
      className="border-b border-outline-variant bg-surface-container-low px-gutter py-3"
    >
      <div className="max-w-container-max-width mx-auto flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-on-surface-variant">
          Send an anonymous error report to help fix this? It never contains your wallet address, tokens or
          transaction data.{" "}
          <Link href="/privacy" className="text-primary underline">
            What is collected
          </Link>
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => {
              setReportingConsent(true);
              setPromptVisible(false);
            }}
            className="rounded-lg bg-primary px-4 py-1.5 text-sm text-on-primary"
          >
            Send report
          </button>
          <button
            type="button"
            onClick={() => {
              setReportingConsent(false);
              setPromptVisible(false);
            }}
            className="rounded-lg border border-outline-variant px-4 py-1.5 text-sm text-on-surface"
          >
            No thanks
          </button>
        </div>
      </div>
    </div>
  );
}
