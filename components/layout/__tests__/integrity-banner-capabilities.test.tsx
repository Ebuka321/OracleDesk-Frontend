import { describe, expect, it, vi } from "vitest";
import React from "react";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IntegrityResult } from "@/lib/stellar/contract-check";

let mockIntegrity: Record<string, IntegrityResult> = {};

vi.mock("@/lib/stellar/contract-check", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stellar/contract-check")>();
  return {
    ...actual,
    useContractIntegrity: () => ({
      data: mockIntegrity,
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    }),
    useContractCapabilities: () => actual.buildCapabilitySnapshot(mockIntegrity as never),
  };
});

const { IntegrityBanner } = await import("../IntegrityBanner");
const { RequiresCapability } = await import("@/components/ui/requires-capability");

describe("IntegrityBanner compatible state and RequiresCapability", () => {
  it("renders quiet info strip for compatible status and expandable capability list", () => {
    mockIntegrity = {
      marketCore: {
        contract: "marketCore",
        id: "C123",
        status: "compatible",
        checkedAtLedger: 100,
        capabilities: {
          "marketCore.core": { ok: true },
          "marketCore.buyV2": { ok: false, reason: "function `buy_v2` missing on-chain" },
        },
      },
    };

    render(<IntegrityBanner />);
    expect(screen.getByText(/Some newer features are unavailable on this deployment/i)).toBeDefined();
    expect(screen.getByText(/marketCore\.buyV2/)).toBeDefined();
    expect(screen.queryByText(/Trading Disabled/i)).toBeNull();
  });

  it("RequiresCapability gates children and shows fallback when capability is missing", () => {
    mockIntegrity = {
      marketCore: {
        contract: "marketCore",
        id: "C123",
        status: "compatible",
        checkedAtLedger: 100,
        capabilities: {
          "marketCore.core": { ok: true },
          "marketCore.buyV2": { ok: false, reason: "missing" },
        },
      },
    };

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <RequiresCapability cap="marketCore.core" fallback={<span>no-core</span>}>
          <span>has-core</span>
        </RequiresCapability>
        <RequiresCapability cap="marketCore.buyV2" fallback={<span>no-v2</span>}>
          <span>has-v2</span>
        </RequiresCapability>
      </QueryClientProvider>,
    );

    expect(screen.getByText("has-core")).toBeDefined();
    expect(screen.queryByText("has-v2")).toBeNull();
    expect(screen.getByText("no-v2")).toBeDefined();
  });
});
