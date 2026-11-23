"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  getAnalyticsConsent,
  hasAnalyticsConsentChoice,
  isAnalyticsConfigured,
  setAnalyticsConsent,
} from "@/lib/observability/analytics";

/**
 * Analytics consent banner (issue #125).
 *
 * Renders only when a provider is configured and no choice is stored yet;
 * nothing is loaded and no event is sent before "Allow" (analytics.ts drops
 * events without consent). Do Not Track and Global Privacy Control never show
 * the banner and are always treated as "no".
 *
 * Not a modal: it is a labelled region with two focusable buttons, so it
 * never traps keyboard focus and stays out of the way of screen readers.
 */
export function ConsentBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isAnalyticsConfigured()) return;
    if (hasAnalyticsConsentChoice()) return;
    const off =
      navigator.doNotTrack === "1" ||
      (navigator as { globalPrivacyControl?: boolean }).globalPrivacyControl === true;
    if (off) return; // signals already answer "no"; no banner, nothing stored
    setVisible(true);
  }, []);

  if (!visible || getAnalyticsConsent()) return null;

  const answer = (value: "granted" | "denied") => {
    setAnalyticsConsent(value);
    setVisible(false);
  };

  return (
    <div
      role="region"
      aria-label="Usage analytics consent"
      data-testid="analytics-consent-banner"
      className="border-b border-outline-variant bg-surface-container-low px-gutter py-3"
    >
      <div className="mx-auto flex max-w-container-max-width flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-on-surface-variant">
          OracleDesk can collect anonymous usage events (no wallet addresses or exact amounts) to improve the
          trading flow.{" "}
          <Link href="/privacy" className="text-primary underline">
            What is collected
          </Link>
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => answer("granted")}
            className="rounded-lg bg-primary px-4 py-1.5 text-sm text-on-primary"
          >
            Allow
          </button>
          <button
            type="button"
            onClick={() => answer("denied")}
            className="rounded-lg border border-outline-variant px-4 py-1.5 text-sm text-on-surface"
          >
            No thanks
          </button>
        </div>
      </div>
    </div>
  );
}
