/**
 * Privacy-first product analytics (issue #125).
 *
 * `track()` is fully typed against `AnalyticsEvents` and is a no-op unless:
 *  1. the build sets `NEXT_PUBLIC_ANALYTICS_PROVIDER` (`posthog | plausible |
 *     http`) — otherwise no provider module is even imported (the switch below
 *     folds away at build time and the dynamic imports are tree-shaken);
 *  2. the user has consented (`localStorage.oracledesk_analytics_consent`),
 *     with Do Not Track / Global Privacy Control always treated as "denied";
 *  3. the payload passes the runtime guard (no StrKey, JWT, 64-hex or long
 *     digit strings may ever leave, whatever a future call site passes).
 *
 * Events are dropped, never queued, before consent — a user who declines (or
 * has not answered yet) must never be tracked retroactively.
 *
 * Every event additionally carries `schema` (ANALYTICS_SCHEMA_VERSION),
 * `route` (pathname only) and `network`.
 */

import { NETWORK_LABEL } from "@/lib/stellar/config";
import { USDC_UNIT } from "@/lib/stellar/units";
import {
  ANALYTICS_SCHEMA_VERSION,
  type AnalyticsEvents,
  type AmountBucket,
  type DurationBucket,
  type EventName,
} from "./analytics-events";

export interface AnalyticsProvider {
  name: string;
  /** Loads the provider script/library. Called once, after consent. */
  load(): Promise<void>;
  capture(event: string, props: Record<string, unknown>): void;
  /** Called when consent is withdrawn. */
  reset(): void;
}

const CONSENT_KEY = "oracledesk_analytics_consent";

/** Inlined at build time: empty means "no analytics in this bundle at all". */
const PROVIDER = (process.env.NEXT_PUBLIC_ANALYTICS_PROVIDER ?? "").trim().toLowerCase();
const HOST = (process.env.NEXT_PUBLIC_ANALYTICS_HOST ?? "").trim();

const KNOWN_WALLET_MODULES = new Set([
  "freighter",
  "albedo",
  "xverse",
  "lobstr",
  "walletconnect",
  "ledger",
  "trezor",
  "keystone",
  "hero",
  "station",
  "exodus",
  "trust",
  "atomic",
  "celer",
  "okto",
  "capsule",
  "busset",
  "stellarx",
]);

/**
 * Wallet module ids come from the kit; anything unexpected (including
 * `null`/`"unknown"`) maps to "other" so arbitrary strings never reach a
 * provider.
 */
export function normalizeWalletModule(id: string | null | undefined): string {
  const value = (id ?? "").trim().toLowerCase();
  return value && value !== "unknown" && KNOWN_WALLET_MODULES.has(value) ? value : "other";
}

export function isAnalyticsConfigured(): boolean {
  return PROVIDER === "posthog" || PROVIDER === "plausible" || PROVIDER === "http";
}

/* ------------------------------------------------------------------ *
 * Consent
 * ------------------------------------------------------------------ */

function privacySignalsOff(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    navigator.doNotTrack === "1" ||
    (navigator as { globalPrivacyControl?: boolean }).globalPrivacyControl === true
  );
}

/** Consent outside a browser (tests, SSR): localStorage is unavailable. */
let memoryConsent: "granted" | "denied" | null = null;

export function hasAnalyticsConsentChoice(): boolean {
  if (typeof window === "undefined") return memoryConsent !== null;
  try {
    return window.localStorage.getItem(CONSENT_KEY) !== null;
  } catch {
    return false;
  }
}

export function getAnalyticsConsent(): boolean {
  if (privacySignalsOff()) return false; // DNT / GPC always win
  if (typeof window === "undefined") return memoryConsent === "granted";
  try {
    return window.localStorage.getItem(CONSENT_KEY) === "granted";
  } catch {
    return false;
  }
}

export function setAnalyticsConsent(value: "granted" | "denied"): void {
  memoryConsent = value;
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(CONSENT_KEY, value);
  } catch {
    // Storage disabled: the in-memory value still applies to this session.
  }
  if (value === "denied") activeProvider?.reset();
}

/* ------------------------------------------------------------------ *
 * Guard
 * ------------------------------------------------------------------ */

const STRKEY_RE = /\b[GCM][A-Z2-7]{55}\b/;
const JWT_RE = /\beyJ[\w-]+\.[\w-]+\.[\w-]+/;
const HEX64_RE = /\b[0-9a-f]{64}\b/i;
const LONG_DIGITS_RE = /\d{8,}/;

/** True when a string looks like an identifier that must never be sent. */
export function isForbiddenValue(value: string): boolean {
  return STRKEY_RE.test(value) || JWT_RE.test(value) || HEX64_RE.test(value) || LONG_DIGITS_RE.test(value);
}

/**
 * Drops the event when any string property looks like an address, token,
 * hash or exact amount. Returns null when the payload must not be sent.
 */
export function guardProperties(props: object): object | null {
  for (const value of Object.values(props)) {
    if (typeof value === "string" && isForbiddenValue(value)) return null;
  }
  return props;
}

/* ------------------------------------------------------------------ *
 * Buckets
 * ------------------------------------------------------------------ */

/** bigint comparisons only — never a float conversion of an exact amount. */
export function bucketUsdc(raw: bigint): AmountBucket {
  if (raw <= 0n) return "<1";
  if (raw < USDC_UNIT) return "<1";
  if (raw < 10n * USDC_UNIT) return "1-10";
  if (raw < 100n * USDC_UNIT) return "10-100";
  if (raw < 1000n * USDC_UNIT) return "100-1k";
  return ">1k";
}

export function bucketDuration(ms: number): DurationBucket {
  if (!Number.isFinite(ms) || ms < 0) return "<5s";
  if (ms < 5_000) return "<5s";
  if (ms < 15_000) return "5-15s";
  if (ms < 60_000) return "15-60s";
  return ">60s";
}

/** Slippage is emitted only when it is one of the app's documented values. */
export function coerceSlippage(bps: number | bigint | undefined): 50 | 100 | 300 | undefined {
  const value = typeof bps === "bigint" ? Number(bps) : bps;
  return value === 50 || value === 100 || value === 300 ? value : undefined;
}

/* ------------------------------------------------------------------ *
 * Provider plumbing
 * ------------------------------------------------------------------ */

let activeProvider: AnalyticsProvider | null = null;
let providerLoading: Promise<AnalyticsProvider | null> | null = null;

/** Replaces the provider (tests, or an embedder). Null disables sending. */
export function setAnalyticsProvider(provider: AnalyticsProvider | null): void {
  activeProvider = provider;
  providerLoading = null;
}

async function resolveProvider(): Promise<AnalyticsProvider | null> {
  if (activeProvider) return activeProvider;
  if (!isAnalyticsConfigured() || providerLoading) return providerLoading ?? activeProvider;
  providerLoading = (async () => {
    let provider: AnalyticsProvider | null = null;
    // Literal specifiers so the bundler can tree-shake every branch whose
    // provider is not configured in this build.
    if (PROVIDER === "posthog") provider = (await import("./providers/posthog")).createPosthogProvider(HOST);
    else if (PROVIDER === "plausible") provider = (await import("./providers/plausible")).createPlausibleProvider(HOST);
    else if (PROVIDER === "http") provider = (await import("./providers/http")).createHttpProvider(HOST);
    if (provider) {
      await provider.load().catch(() => undefined); // never break the app for analytics
      activeProvider = provider;
    }
    return provider;
  })();
  return providerLoading;
}

function currentRoute(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname;
}

/**
 * Records one funnel event. Compile-time typed: an unknown event name or a
 * property that does not belong to it fails `npm run typecheck`.
 */
export function track<E extends EventName>(event: E, props: AnalyticsEvents[E]): void {
  if (!isAnalyticsConfigured()) return;
  if (!getAnalyticsConsent()) return; // dropped, never queued

  const safe = guardProperties(props);
  if (!safe) {
    if (process.env.NODE_ENV !== "production") {
      try {
        console.warn(`[analytics] dropped ${event}: a property looked like an identifier`);
      } catch {
        // console unavailable
      }
    }
    return;
  }

  // Our fields last: a property named `route`/`network`/`schema` can never
  // spoof them (the catalog forbids them anyway; the schema test catches it).
  const payload = {
    ...safe,
    schema: ANALYTICS_SCHEMA_VERSION,
    route: currentRoute(),
    network: NETWORK_LABEL,
  };

  void resolveProvider()
    .then((provider) => provider?.capture(event, payload))
    .catch(() => undefined);
}

/** Exposed for tests: forget any loaded provider. */
export function __resetAnalyticsForTests(): void {
  activeProvider = null;
  providerLoading = null;
  memoryConsent = null;
}
