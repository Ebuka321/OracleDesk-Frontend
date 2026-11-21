import { describe, expect, it, vi, beforeEach } from "vitest";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { ViewedAddressProvider, useViewedAddress } from "@/lib/hooks/useViewedAddress";
import { useBuy } from "@/lib/hooks/useStellar";
import { NETWORK_PASSPHRASE } from "@/lib/stellar/config";
import type { IntegrityResult } from "@/lib/stellar/contract-check";
import type { UserFacingError } from "@/lib/stellar/errors";

const CONNECTED = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const WATCHED = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";

const mockSigner = {
  publicKey: CONNECTED,
  signTransaction: vi.fn(async (xdr: string) => ({ signedTxXdr: xdr })),
};

vi.mock("@/lib/stellar/WalletProvider", () => ({
  useWalletAddress: () => ({ address: CONNECTED, isConnected: true }),
  useWalletSigner: () => mockSigner,
  useWalletNetwork: () => ({
    isWrongNetwork: false,
    rpcNetwork: { status: "ok", protocolVersion: 23 },
    walletNetwork: { state: "match", confirmedByUser: true },
    networkEpoch: 1,
    assertNetworkCurrent: vi.fn(),
  }),
}));

vi.mock("@/lib/contexts/WalletContext", () => ({
  useWallet: () => ({
    address: CONNECTED,
    isConnected: true,
    isWrongNetwork: false,
    signer: mockSigner,
    rpcNetwork: { status: "ok", protocolVersion: 23 },
    walletNetwork: { state: "match", confirmedByUser: true },
    networkEpoch: 1,
    assertNetworkCurrent: vi.fn(),
  }),
  useWalletAddress: () => ({ address: CONNECTED, isConnected: true }),
  useWalletSigner: () => mockSigner,
  useWalletNetwork: () => ({
    isWrongNetwork: false,
    rpcNetwork: { status: "ok", protocolVersion: 23 },
    walletNetwork: { state: "match", confirmedByUser: true },
    networkEpoch: 1,
    assertNetworkCurrent: vi.fn(),
  }),
}));

vi.mock("@/lib/api/auth", () => ({
  getStoredSessionWallet: () => null,
  clearAuthSession: () => {},
  signInWithWallet: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  notifyAuthInvalid: () => false,
  onAuthSessionChanged: () => () => {},
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiFetch: vi.fn(),
  apiPath: (...p: string[]) => p.join("/"),
  API_URL: "http://localhost:8787/api/v1",
  ApiError: class ApiError extends Error {},
}));

vi.mock("@/lib/stellar/tx-tracker", () => ({
  useTxTracker: () => ({ track: vi.fn() }),
}));

vi.mock("@/lib/pwa/register", () => ({
  useUpdatePending: () => false,
  BUILD_ID: "test-build",
}));

vi.mock("@/lib/stellar/trustline", () => ({
  getTrustlineState: vi.fn(async () => ({ kind: "present", authorized: true })),
  enableUsdcTrustline: vi.fn(),
  usdcClassicAsset: vi.fn(),
}));

vi.mock("@/lib/stellar/clients", () => ({
  marketCore: () => ({ spec: {} }),
  treasury: () => ({ spec: {} }),
  resolver: () => ({ spec: {} }),
  reasoningRegistry: () => ({ spec: {} }),
  token: { name: vi.fn(), balance: vi.fn(), transfer: vi.fn() },
  rpcServer: vi.fn(),
  rpcPool: () => null,
  withPinnedRpc: async (fn: (u: string) => Promise<unknown>) => fn("https://rpc.example"),
  Outcomes: { Yes: { tag: "Yes", values: undefined }, No: { tag: "No", values: undefined } },
}));

describe("useWriteGuard hook integration", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("rejects useBuy with kind watch-only when ?watch=<other G> is active", async () => {
    window.history.replaceState(null, "", `/portfolio?watch=${WATCHED}`);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["stellar", "integrity", NETWORK_PASSPHRASE], {
      marketCore: { contract: "marketCore", id: "C1", status: "match", checkedAtLedger: 1 },
    } satisfies Partial<Record<string, IntegrityResult>>);

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>
        <ViewedAddressProvider>{children}</ViewedAddressProvider>
      </QueryClientProvider>
    );

    const { result } = renderHook(
      () => ({ buy: useBuy(), viewed: useViewedAddress() }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.viewed.isWatching).toBe(true));

    let caught: UserFacingError | null = null;
    try {
      await result.current.buy.mutateAsync({
        marketId: 1n,
        outcome: "Yes",
        collateralIn: 10_000_000n,
        slippageBps: 100,
      });
    } catch (e) {
      caught = e as UserFacingError;
    }

    expect(caught).not.toBeNull();
    expect(caught?.described.kind).toBe("watch-only");
  });

  it("rejects useBuy with kind contract when integrity is mismatch", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["stellar", "integrity", NETWORK_PASSPHRASE], {
      marketCore: { contract: "marketCore", id: "C1", status: "mismatch", detail: "spec mismatch", checkedAtLedger: 1 },
    } satisfies Partial<Record<string, IntegrityResult>>);

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>
        <ViewedAddressProvider>{children}</ViewedAddressProvider>
      </QueryClientProvider>
    );

    const { result } = renderHook(() => useBuy(), { wrapper });

    let caught: UserFacingError | null = null;
    try {
      await result.current.mutateAsync({
        marketId: 1n,
        outcome: "Yes",
        collateralIn: 10_000_000n,
        slippageBps: 100,
      });
    } catch (e) {
      caught = e as UserFacingError;
    }

    expect(caught).not.toBeNull();
    expect(caught?.described.kind).toBe("contract");
  });

  it("passes the write guard when integrity is unchecked and preserves copy-trade outbox across watch toggle", async () => {
    const outboxKey = `oracledesk_copy_outbox:${CONNECTED}`;
    window.localStorage.setItem(outboxKey, JSON.stringify([{ id: "tx-1", status: "pending" }]));

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["stellar", "integrity", NETWORK_PASSPHRASE], {
      marketCore: { contract: "marketCore", id: "C1", status: "unchecked", checkedAtLedger: 0 },
    } satisfies Partial<Record<string, IntegrityResult>>);

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>
        <ViewedAddressProvider>{children}</ViewedAddressProvider>
      </QueryClientProvider>
    );

    const { result } = renderHook(() => useViewedAddress(), { wrapper });
    await waitFor(() => expect(result.current.hydrated).toBe(true));

    result.current.setWatch(WATCHED);
    await waitFor(() => expect(result.current.isWatching).toBe(true));
    result.current.clearWatch();
    await waitFor(() => expect(result.current.isWatching).toBe(false));

    expect(window.localStorage.getItem(outboxKey)).toContain("tx-1");
  });
});
