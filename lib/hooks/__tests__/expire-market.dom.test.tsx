// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ResolutionDeadlineCard } from "@/components/market/resolution-deadline-card";
import { RESOLUTION_GRACE_SECS } from "@/lib/stellar/resolution-deadline";

const mockPreviewExpire = vi.fn();
const mockReadDeadline = vi.fn();
const mockMutateAsync = vi.fn();
const mockDeadlineHook = () => ({ data: {
  closeTime: 1_000_000n,
  resolutionDeadline: 1_000_000n + RESOLUTION_GRACE_SECS,
  fallbackOpensAt: null,
  resolverState: "SignersPending",
  phase: "expirable",
} });
const mockPreviewHook = () => ({ data: {
  ok: true,
  effect: { kind: "void" },
  simulatedAtLedger: 1200,
  fee: 1000n,
} });
let mockIsWatching = false;
let mockAddress: string | null = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

vi.mock("@/lib/contexts/WalletContext", () => ({
  useWalletAddress: () => ({ address: mockAddress, isConnected: Boolean(mockAddress) }),
  useWallet: () => ({ address: mockAddress, isConnected: Boolean(mockAddress) }),
  useWalletSigner: () => null,
  useWalletNetwork: () => ({ isWrongNetwork: false, rpcNetwork: { status: "ok" } }),
}));

vi.mock("@/lib/hooks/useViewedAddress", () => ({
  useViewedAddress: () => ({ isWatching: mockIsWatching, viewed: mockAddress }),
}));

vi.mock("@/lib/stellar/ledger-clock", () => ({
  useLedgerNow: () => ({ now: 4_000_000, ledger: 1200, uncertainty: 5 }),
  ledgerClock: { now: () => 4_000_000, uncertainty: () => 5, estimateNow: () => ({ ledger: 1200, time: 4_000_000 }) },
}));

vi.mock("@/lib/stellar/resolution-deadline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stellar/resolution-deadline")>();
  return {
    ...actual,
    supportsExpiryAndFallback: () => true,
    readDeadline: (...args: unknown[]) => mockReadDeadline(...args),
    previewExpire: (...args: unknown[]) => mockPreviewExpire(...args),
  };
});

vi.mock("@/lib/hooks/useStellar", () => ({
  useResolutionDeadline: (...args: unknown[]) => ({ data: undefined, ...mockDeadlineHook(...args) }),
  useExpiryPreview: (...args: unknown[]) => ({ data: undefined, ...mockPreviewHook(...args) }),
  usePosition: () => ({ data: { value: { yes: 10_000_000n, no: 2_000_000n } } }),
  useExpireMarket: () => ({ mutateAsync: mockMutateAsync, isPending: false }),
  useOpenFallback: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRedeem: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ResolutionDeadlineCard onChainMarketId="7" />
    </QueryClientProvider>,
  );
}

describe("ResolutionDeadlineCard & expire_market", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsWatching = false;
    mockAddress = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    mockReadDeadline.mockResolvedValue({
      closeTime: 1_000_000n,
      resolutionDeadline: 1_000_000n + RESOLUTION_GRACE_SECS,
      fallbackOpensAt: null,
      resolverState: "SignersPending",
      phase: "expirable",
    });
    mockPreviewExpire.mockResolvedValue({
      ok: true,
      effect: { kind: "void" },
      simulatedAtLedger: 1200,
      fee: 1000n,
    });
  });

  it("hides action button for watch-only viewers", async () => {
    mockIsWatching = true;
    renderCard();
    await waitFor(() => expect(screen.getByText(/past its resolution deadline/i)).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Expire market/i })).toBeNull();
  });

  it("shows simulated void effect and payout in confirmation dialog and invokes expire mutation", async () => {
    mockMutateAsync.mockResolvedValue({ txHash: "a".repeat(64), effect: { kind: "void" }, holder: mockAddress });
    renderCard();
    const btn = await screen.findByRole("button", { name: /Expire market/i });
    fireEvent.click(btn);
    expect(screen.getByText(/Void market/i)).toBeTruthy();
    expect(screen.getByText(/0\.60 USDC/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Confirm & Sign/i }));
    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledWith({
      marketId: "7",
      expectedEffect: { kind: "void" },
    }));
    expect(await screen.findByRole("button", { name: /Redeem now/i })).toBeTruthy();
  });
});
