/**
 * Plausible provider (issue #125), loaded only after consent.
 *
 * Plausible is cookieless by design, but the script still only loads after an
 * explicit "Allow". `NEXT_PUBLIC_ANALYTICS_HOST` is the origin that serves
 * `js/script.js` — self-hostable, and the only extra origin CSP must allow.
 *
 * Custom events: `plausible(eventName, { props })`.
 */

import type { AnalyticsProvider } from "../analytics";

interface PlausibleWindow {
  plausible?: (event: string, options?: { props?: Record<string, unknown> }) => void;
}

export function createPlausibleProvider(host: string): AnalyticsProvider {
  const origin = host.replace(/\/$/, "");
  let ready = false;

  return {
    name: "plausible",

    async load(): Promise<void> {
      if (ready || typeof window === "undefined" || typeof document === "undefined") return;
      if (!origin) return;
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = `${origin}/js/script.js`;
        script.defer = true;
        script.dataset.domain = window.location.hostname;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("plausible script failed to load"));
        document.head.appendChild(script);
      });
      ready = typeof (window as PlausibleWindow).plausible === "function";
    },

    capture(event, props): void {
      if (!ready) return;
      (window as PlausibleWindow).plausible?.(event, { props });
    },

    reset(): void {
      // Plausible has no client-side reset; nothing is stored to clear.
    },
  };
}
