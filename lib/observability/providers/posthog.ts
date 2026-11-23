/**
 * PostHog provider (issue #125), loaded only after consent.
 *
 * posthog-js is loaded from the configured host's own `/static/array.js`
 * (the standard snippet) rather than bundled from npm, so the default build
 * ships no analytics code and the only extra origin is the one the operator
 * configured. Cookieless config: memory persistence, no autocapture, no
 * pageview capture, no session recording, no IP handling, and `identify()`
 * is never called — there is no user id to call it with.
 *
 * Origin allowed by CSP after consent: NEXT_PUBLIC_ANALYTICS_HOST.
 */

import type { AnalyticsProvider } from "../analytics";

interface PosthogWindow {
  posthog?: {
    init(apiHost: string, config: Record<string, unknown>): void;
    capture(event: string, props?: Record<string, unknown>): void;
    reset(): void;
    opt_in_capturing?(): void;
    opt_out_capturing?(): void;
  };
}

export function createPosthogProvider(host: string): AnalyticsProvider {
  const apiHost = host.replace(/\/$/, "");
  let ready = false;

  return {
    name: "posthog",

    async load(): Promise<void> {
      if (ready || typeof window === "undefined" || typeof document === "undefined") return;
      if (!apiHost) return;
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = `${apiHost}/static/array.js`;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("posthog script failed to load"));
        document.head.appendChild(script);
      });
      const posthog = (window as PosthogWindow).posthog;
      if (!posthog) throw new Error("posthog global missing after script load");
      posthog.init(apiHost, {
        api_host: apiHost,
        persistence: "memory",
        autocapture: false,
        capture_pageview: false,
        disable_session_recording: true,
        ip: false,
        respect_dnt: true,
        opt_out_capturing_by_default: true,
      });
      posthog.opt_in_capturing?.();
      ready = true;
    },

    capture(event, props): void {
      if (!ready) return;
      (window as PosthogWindow).posthog?.capture(event, props);
    },

    reset(): void {
      if (!ready) return;
      (window as PosthogWindow).posthog?.opt_out_capturing?.();
    },
  };
}
