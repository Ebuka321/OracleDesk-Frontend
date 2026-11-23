import { describe, expect, it } from "vitest";
import {
  DEFAULT_NEAR_WINDOW_SECS,
  RESOLUTION_GRACE_SECS,
  decodeExpirySimulationEvents,
  phaseAt,
  type DeadlineView,
} from "../resolution-deadline";

describe("resolution-deadline", () => {
  const base: Omit<DeadlineView, "phase"> = {
    closeTime: 1_000_000n,
    resolutionDeadline: 1_000_000n + RESOLUTION_GRACE_SECS,
    fallbackOpensAt: 1_000_000n + 3_600n,
    resolverState: "HybridPricePending",
  };

  it("RESOLUTION_GRACE_SECS equals 30 days", () => {
    expect(RESOLUTION_GRACE_SECS).toBe(2_592_000n);
  });

  it("computes phaseAt boundaries and respects clock uncertainty", () => {
    expect(phaseAt(base, 999_000n, DEFAULT_NEAR_WINDOW_SECS, 5n)).toBe("open");
    // Uncertainty overlaps close_time
    expect(phaseAt(base, 1_000_002n, DEFAULT_NEAR_WINDOW_SECS, 5n)).toBe("awaiting-resolution");
    // Fallback boundary: not passed while uncertainty overlaps
    expect(phaseAt(base, 1_003_602n, DEFAULT_NEAR_WINDOW_SECS, 5n)).toBe("awaiting-resolution");
    expect(phaseAt(base, 1_003_605n, DEFAULT_NEAR_WINDOW_SECS, 5n)).toBe("fallback-openable");
    // Deadline near
    const nearBase = { ...base, resolverState: "SignersPending" as const, fallbackOpensAt: null };
    expect(phaseAt(nearBase, base.resolutionDeadline - 100n, DEFAULT_NEAR_WINDOW_SECS, 5n)).toBe(
      "deadline-near",
    );
    // Expirable only once ledgerNow - uncertainty >= resolutionDeadline
    expect(phaseAt(nearBase, base.resolutionDeadline + 2n, DEFAULT_NEAR_WINDOW_SECS, 5n)).toBe(
      "deadline-near",
    );
    expect(phaseAt(nearBase, base.resolutionDeadline + 5n, DEFAULT_NEAR_WINDOW_SECS, 5n)).toBe(
      "expirable",
    );
    // Terminal states
    expect(phaseAt({ ...nearBase, resolverState: "Finalized" }, base.resolutionDeadline + 100n)).toBe(
      "terminal",
    );
    expect(phaseAt({ ...nearBase, resolverState: "Expired" }, base.resolutionDeadline + 100n)).toBe(
      "terminal",
    );
  });

  it("decodes void, resolve, fallback-opened, and rejects unknown events", () => {
    expect(
      decodeExpirySimulationEvents([{ name: "MarketExpired", data: { market_id: 1n } }]),
    ).toEqual({ kind: "void" });

    expect(
      decodeExpirySimulationEvents([
        { name: "PriceResolution", data: { market_id: 1n, outcome: { tag: "Yes" } } },
      ]),
    ).toEqual({ kind: "resolve", outcome: "Yes" });

    expect(
      decodeExpirySimulationEvents([{ name: "FallbackOpened", data: { market_id: 1n } }]),
    ).toEqual({ kind: "fallback-opened" });

    expect(decodeExpirySimulationEvents([{ name: "UnknownEvent", data: {} }])).toBeNull();
    expect(decodeExpirySimulationEvents([])).toBeNull();
  });
});
