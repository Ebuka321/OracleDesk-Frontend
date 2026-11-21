import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import PriceChart from "../price-chart";
import { TraceVerificationCache } from "@/lib/charts/trace-overlay-cache";
import type { OnChainMarketTrace } from "@/lib/stellar/market-audit";
import type { PricePoint } from "@/lib/stellar/price-history";
import type { TraceCheck } from "@/lib/stellar/trace-core";

const HASH_GOOD = "a".repeat(64);
const HASH_BAD = "b".repeat(64);
const AGENT_1 = "GCM7WU3RADBCIKBLGPPAEYV5WHASWMEQX6BU524QR3QFWSE7BIWCXAIF";
const AGENT_2 = "GB7TAYRUZGE6TVT7NHP5SMIZRNQA6PLM423EYISAOAP3MKYIQMVYP2JO";

describe("PriceChart verified agent estimate overlay (Issue #243)", () => {
  const base = 1_760_000_400;
  const points: PricePoint[] = [
    { time: base - 1_800, yesBps: 5000n, ledger: 100 },
    { time: base, yesBps: 6000n, ledger: 110 },
    { time: base + 1_800, yesBps: 6500n, ledger: 120 },
  ];

  const traces: OnChainMarketTrace[] = [
    {
      index: 0,
      onChainTraceId: "101",
      agent: AGENT_1,
      action: "BUY_YES",
      ipfsCid: "QmVerified",
      publishedAt: (base + 60) * 1000,
      traceHash: HASH_GOOD,
    },
    {
      index: 1,
      onChainTraceId: "102",
      agent: AGENT_2,
      action: "BUY_NO",
      ipfsCid: "QmTampered",
      publishedAt: (base + 120) * 1000,
      traceHash: HASH_BAD,
    },
  ];

  it("renders verified estimate numbers, hides numbers for unverified/mismatched traces, and supports keyboard access & sr-only table", async () => {
    const cache = new TraceVerificationCache();
    const verifyTrace = vi.fn(async (trace: OnChainMarketTrace): Promise<TraceCheck> => {
      if (trace.onChainTraceId === "101") {
        return {
          status: "verified",
          computedHash: HASH_GOOD,
          content: {
            agent: "AlphaAgent",
            probabilityEstimate: 0.74,
            confidenceInterval: { lower: 0.68, upper: 0.8 },
          },
        };
      }
      return { status: "mismatch", computedHash: "c".repeat(64) };
    });

    render(
      <PriceChart
        points={points}
        traces={traces}
        verifyTrace={verifyTrace}
        verificationCache={cache}
      />,
    );

    // Wait for async verification to settle
    const verifiedBtn = await waitFor(() =>
      screen.getByRole("button", { name: /AlphaAgent.*verified estimate 74\.0%.*confidence interval 68\.0% to 80\.0%/i }),
    );
    const mismatchBtn = screen.getByRole("button", {
      name: /hash mismatch trace, no estimate displayed/i,
    });

    // Verified button displays the number; unverified/mismatched button displays NO number
    expect(verifiedBtn.textContent).toContain("74.0%");
    expect(mismatchBtn.textContent).not.toMatch(/%/);

    // Focus opens popover and ArrowRight moves focus to the next marker
    fireEvent.focus(verifiedBtn);
    expect(screen.getByRole("status").textContent).toContain("Verified estimate: 74.0%");

    fireEvent.keyDown(verifiedBtn, { key: "ArrowRight" });
    expect(document.activeElement).toBe(mismatchBtn);

    // Visually hidden table provides full text alternative
    const table = screen.getByRole("table");
    expect(table.textContent).toContain("AlphaAgent");
    expect(table.textContent).toContain("74.0%");
    expect(table.textContent).toContain("Not displayed");
  });
});
