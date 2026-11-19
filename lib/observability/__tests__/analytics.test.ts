import { afterEach, describe, expect, it, vi } from "vitest";
// Static import: the guard itself is configuration-independent (the env is
// read at import time, which would otherwise couple it to the reloads below).
import { isForbiddenValue, type AnalyticsProvider } from "../analytics";

/**
 * Issue #125: privacy-first funnel analytics.
 *
 * The module reads NEXT_PUBLIC_ANALYTICS_PROVIDER at import time, so each
 * scenario reloads it with a fresh env value and injects a capture spy.
 * Consent lives in localStorage when a window exists, otherwise in module
 * memory (node) — both paths are exercised below.
 */

const G_ADDRESS = "GD2NB2VUME7ECMHFHQN5M3KUZLLJF3R6Z4OFCBLE4SJNHIQHITRPQGHQ";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef";

const ORIGINAL_PROVIDER = process.env.NEXT_PUBLIC_ANALYTICS_PROVIDER;

interface Loaded {
  mod: typeof import("../analytics");
  captured: Array<{ event: string; props: Record<string, unknown> }>;
}

function setProviderEnv(value: string): void {
  if (value === "") delete process.env.NEXT_PUBLIC_ANALYTICS_PROVIDER;
  else process.env.NEXT_PUBLIC_ANALYTICS_PROVIDER = value;
}

/** Reloads the module with `provider` configured and a capture spy injected. */
async function load(provider = "http"): Promise<Loaded> {
  setProviderEnv(provider);
  vi.resetModules();
  const mod = await import("../analytics");
  const captured: Loaded["captured"] = [];
  const spy: AnalyticsProvider = {
    name: "spy",
    load: async () => undefined,
    capture: (event, props) => {
      captured.push({ event, props });
    },
    reset: () => undefined,
  };
  mod.setAnalyticsProvider(spy);
  return { mod, captured };
}

/** Lets track()'s provider promise chain settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Minimal window with localStorage + location for route/consent tests. */
function stubWindow(pathname: string): void {
  const store = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
    location: { pathname, search: "?tab=1", hash: "#top" },
  });
}

afterEach(() => {
  if (ORIGINAL_PROVIDER === undefined) delete process.env.NEXT_PUBLIC_ANALYTICS_PROVIDER;
  else process.env.NEXT_PUBLIC_ANALYTICS_PROVIDER = ORIGINAL_PROVIDER;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("configuration", () => {
  it("is a no-op when no provider is configured", async () => {
    const { mod, captured } = await load("");
    expect(mod.isAnalyticsConfigured()).toBe(false);
    mod.setAnalyticsConsent("granted");
    mod.track("signin_started", {});
    mod.track("wallet_modal_opened", {});
    await flush();
    expect(captured).toHaveLength(0);
  });

  const PROVIDER_CASES: Array<[string, boolean]> = [
    ["posthog", true],
    ["plausible", true],
    ["http", true],
    ["POSTHOG", true],
    ["  http  ", true],
    ["matomo", false],
    ["", false],
  ];
  it.each(PROVIDER_CASES)("treats provider %j as configured=%s", async (provider, expected) => {
    const { mod } = await load(provider);
    expect(mod.isAnalyticsConfigured()).toBe(expected);
  });
});

describe("consent gating", () => {
  it("drops events until consent is granted and never replays them", async () => {
    const { mod, captured } = await load();
    mod.track("signin_started", {});
    await flush();
    expect(captured).toHaveLength(0); // dropped, not queued

    mod.setAnalyticsConsent("granted");
    mod.track("signin_started", {});
    await flush();
    expect(captured).toHaveLength(1); // only the post-consent event
    expect(captured[0].event).toBe("signin_started");
  });

  it("drops events when consent is denied", async () => {
    const { mod, captured } = await load();
    mod.setAnalyticsConsent("denied");
    mod.track("trade_submitted", { action: "buy" });
    await flush();
    expect(captured).toHaveLength(0);
  });

  it("honours Do Not Track over stored consent", async () => {
    const { mod, captured } = await load();
    mod.setAnalyticsConsent("granted");
    vi.stubGlobal("navigator", { doNotTrack: "1" });
    mod.track("trade_submitted", { action: "buy" });
    await flush();
    expect(captured).toHaveLength(0);
  });

  it("honours Global Privacy Control over stored consent", async () => {
    const { mod, captured } = await load();
    mod.setAnalyticsConsent("granted");
    vi.stubGlobal("navigator", { globalPrivacyControl: true });
    mod.track("trade_submitted", { action: "buy" });
    await flush();
    expect(captured).toHaveLength(0);
  });

  it("resets the provider when consent is withdrawn", async () => {
    const { mod } = await load();
    const reset = vi.fn();
    mod.setAnalyticsProvider({
      name: "spy",
      load: async () => undefined,
      capture: () => undefined,
      reset,
    });
    mod.setAnalyticsConsent("granted");
    mod.setAnalyticsConsent("denied");
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("remembers a stored choice across reloads", async () => {
    const first = await load();
    stubWindow("/markets");
    first.mod.setAnalyticsConsent("granted");
    expect(first.mod.hasAnalyticsConsentChoice()).toBe(true);
    expect(first.mod.getAnalyticsConsent()).toBe(true);

    const second = await load(); // fresh module, same localStorage
    expect(second.mod.hasAnalyticsConsentChoice()).toBe(true);
    expect(second.mod.getAnalyticsConsent()).toBe(true);
  });
});

describe("runtime identifier guard", () => {
  const GUARD_CASES: Array<[string, boolean]> = [
    [G_ADDRESS, true],
    [JWT, true],
    ["ab".repeat(32), true], // 64-hex (transaction-hash shaped)
    ["12345678", true], // 8+ consecutive digits (exact amount shaped)
    ["SlippageExceeded", false],
    ["quote_buy", false],
    ["1-10", false],
    ["50", false],
  ];
  it.each(GUARD_CASES)("classifies %j as forbidden=%s", (value, forbidden) => {
    expect(isForbiddenValue(value)).toBe(forbidden);
  });

  it("drops an event whose property looks like an address", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { mod, captured } = await load();
    mod.setAnalyticsConsent("granted");
    mod.track("quote_failed", { kind: "network", code: G_ADDRESS });
    await flush();
    expect(captured).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dropped quote_failed"));
  });

  it("passes ordinary values through unchanged", async () => {
    const { mod } = await load();
    const props = { kind: "contract", code: "SlippageExceeded" };
    expect(mod.guardProperties(props)).toBe(props);
    expect(mod.guardProperties({ n: 123456789, flag: true })).not.toBeNull(); // only strings are inspected
  });
});

describe("buckets", () => {
  it("buckets USDC amounts on bigint boundaries", async () => {
    const { bucketUsdc } = await load();
    expect(bucketUsdc(0n)).toBe("<1");
    expect(bucketUsdc(9_999_999n)).toBe("<1"); // 0.9999999
    expect(bucketUsdc(10_000_000n)).toBe("1-10"); // exactly 1
    expect(bucketUsdc(99_999_999n)).toBe("1-10"); // 9.9999999
    expect(bucketUsdc(100_000_000n)).toBe("10-100"); // exactly 10
    expect(bucketUsdc(999_999_999n)).toBe("10-100"); // 99.9999999
    expect(bucketUsdc(1_000_000_000n)).toBe("100-1k"); // exactly 100
    expect(bucketUsdc(9_999_999_999n)).toBe("100-1k"); // 999.9999999
    expect(bucketUsdc(10_000_000_000n)).toBe(">1k"); // exactly 1000
    expect(bucketUsdc(10_000_000_001n)).toBe(">1k"); // 1000.0000001
  });

  it("buckets durations", async () => {
    const { bucketDuration } = await load();
    expect(bucketDuration(-1)).toBe("<5s");
    expect(bucketDuration(0)).toBe("<5s");
    expect(bucketDuration(4_999)).toBe("<5s");
    expect(bucketDuration(5_000)).toBe("5-15s");
    expect(bucketDuration(14_999)).toBe("5-15s");
    expect(bucketDuration(15_000)).toBe("15-60s");
    expect(bucketDuration(59_999)).toBe("15-60s");
    expect(bucketDuration(60_000)).toBe(">60s");
    expect(bucketDuration(Infinity)).toBe("<5s");
  });

  it("emits only the documented slippage values", async () => {
    const { coerceSlippage } = await load();
    expect(coerceSlippage(50)).toBe(50);
    expect(coerceSlippage(100)).toBe(100);
    expect(coerceSlippage(300)).toBe(300);
    expect(coerceSlippage(50n)).toBe(50);
    expect(coerceSlippage(25)).toBeUndefined();
    expect(coerceSlippage(0)).toBeUndefined();
    expect(coerceSlippage(500)).toBeUndefined();
    expect(coerceSlippage(undefined)).toBeUndefined();
  });

  it("normalises wallet module ids to a fixed list", async () => {
    const { normalizeWalletModule } = await load();
    expect(normalizeWalletModule("freighter")).toBe("freighter");
    expect(normalizeWalletModule("Freighter")).toBe("freighter");
    expect(normalizeWalletModule("LEDGER")).toBe("ledger");
    expect(normalizeWalletModule("unknown")).toBe("other");
    expect(normalizeWalletModule("UNKNOWN")).toBe("other");
    expect(normalizeWalletModule(null)).toBe("other");
    expect(normalizeWalletModule("")).toBe("other");
    expect(normalizeWalletModule("some-exotic-sdk")).toBe("other");
  });
});

describe("payload", () => {
  it("adds schema, route and network; route is the pathname only", async () => {
    const { mod, captured } = await load();
    stubWindow("/markets/42");
    mod.setAnalyticsConsent("granted");
    mod.track("trade_completed", {
      action: "buy",
      outcome: "success",
      durationBucket: "5-15s",
    });
    await flush();

    expect(captured).toHaveLength(1);
    const { event, props } = captured[0];
    expect(event).toBe("trade_completed");
    expect(props.schema).toBe(1);
    expect(props.route).toBe("/markets/42"); // no ?tab=1, no #top
    expect(String(props.network)).toContain("Stellar");
    expect(props.action).toBe("buy");
    expect(props.durationBucket).toBe("5-15s");
  });

  it("swallows provider failures instead of breaking the app", async () => {
    const { mod } = await load();
    mod.setAnalyticsProvider({
      name: "broken",
      load: async () => undefined,
      capture: () => {
        throw new Error("provider exploded");
      },
      reset: () => undefined,
    });
    mod.setAnalyticsConsent("granted");
    expect(() => mod.track("signin_started", {})).not.toThrow();
    await flush();
  });
});
