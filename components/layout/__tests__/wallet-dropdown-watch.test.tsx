import { describe, expect, it, vi, beforeEach } from "vitest";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ViewedAddressProvider } from "@/lib/hooks/useViewedAddress";
import { ViewingBanner } from "@/components/layout/ViewingBanner";
import WalletDropdown from "../WalletDropdown";

const CONNECTED = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const WATCHED = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";

let walletState = { address: CONNECTED as string | null, isConnected: true };

vi.mock("@/lib/contexts/WalletContext", () => ({
  useWalletAddress: () => walletState,
  useWalletNetwork: () => ({ isWrongNetwork: false, walletNetwork: { state: "match" }, confirmUnknownNetwork: vi.fn() }),
  useWalletSession: () => ({ isConnecting: false, error: null }),
  useWalletActions: () => ({ openModal: vi.fn(), disconnect: vi.fn() }),
}));

vi.mock("@/lib/hooks/useStellar", () => ({
  useAccountReserve: () => ({ data: { funded: true, balance: 100000000n }, isLoading: false, isError: false }),
  useEnableUsdc: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRpcNetwork: () => ({ data: { friendbotUrl: "https://friendbot.stellar.org" } }),
  useUsdcBalance: () => ({ data: 500000000n, isError: false }),
  useUsdcTrustline: () => ({ data: { kind: "present", authorized: true } }),
  useUsdcBalanceState: () => ({ data: undefined }),
}));

describe("WalletDropdown watch controls", () => {
  beforeEach(() => {
    walletState = { address: CONNECTED, isConnected: true };
    window.sessionStorage.clear();
    window.history.replaceState(null, "", `/portfolio?watch=${WATCHED}`);
  });

  it("Stop watching in WalletDropdown clears sessionStorage, URL param, and hides ViewingBanner", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ViewedAddressProvider>
          <ViewingBanner />
          <WalletDropdown />
        </ViewedAddressProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText(/Watch-Only Mode/i)).toBeDefined();
    });
    expect(window.sessionStorage.getItem("oracledesk_watch")).toBe(WATCHED);

    // Open wallet menu
    fireEvent.pointerDown(screen.getByRole("button", { name: "Wallet menu" }));

    const stopItem = await screen.findByRole("menuitem", { name: /Stop watching/i });
    fireEvent.click(stopItem);

    await waitFor(() => {
      expect(screen.queryByText(/Watch-Only Mode/i)).toBeNull();
    });
    expect(window.sessionStorage.getItem("oracledesk_watch")).toBeNull();
    expect(new URLSearchParams(window.location.search).get("watch")).toBeNull();
  });

  it("offers Stop watching when disconnected while watching", async () => {
    walletState = { address: null, isConnected: false };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ViewedAddressProvider>
          <ViewingBanner />
          <WalletDropdown />
        </ViewedAddressProvider>
      </QueryClientProvider>,
    );

    const stopBtns = await screen.findAllByRole("button", { name: "Stop watching" });
    fireEvent.click(stopBtns[stopBtns.length - 1]);

    await waitFor(() => {
      expect(screen.queryByText(/Watch-Only Mode/i)).toBeNull();
    });
    expect(window.sessionStorage.getItem("oracledesk_watch")).toBeNull();
  });
});
