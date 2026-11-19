/**
 * Self-hosted JSON endpoint provider (issue #125).
 *
 * `NEXT_PUBLIC_ANALYTICS_HOST` is a POST endpoint that accepts the event
 * JSON. Uses `navigator.sendBeacon` (keeps the page unload-safe) with a
 * `fetch(..., { keepalive: true })` fallback. No script is loaded, so the
 * only origin involved is the configured host itself.
 */

import type { AnalyticsProvider } from "../analytics";

export function createHttpProvider(host: string): AnalyticsProvider {
  const endpoint = host.trim();

  return {
    name: "http",

    async load(): Promise<void> {
      // Nothing to load: beacons are plain HTTP requests.
    },

    capture(event, props): void {
      if (!endpoint || typeof window === "undefined") return;
      const body = JSON.stringify({ event, ...props });
      try {
        if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
          const queued = navigator.sendBeacon(endpoint, new Blob([body], { type: "application/json" }));
          if (queued) return;
        }
      } catch {
        // Fall through to fetch.
      }
      void fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        keepalive: true,
        mode: "cors",
      }).catch(() => undefined);
    },

    reset(): void {
      // Nothing is stored client-side.
    },
  };
}
