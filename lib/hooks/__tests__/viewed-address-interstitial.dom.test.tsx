// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrKey } from "@stellar/stellar-sdk";
import { ViewedAddressProvider, useViewedAddress } from "../useViewedAddress";

vi.mock("@/lib/contexts/WalletContext", () => ({
  useWalletAddress: () => ({ address: null, isConnected: false }),
}));

function makeAccount(seed: number): string {
  const bytes = new Uint8Array(32).fill(seed & 0xff);
  bytes[0] = (seed >> 8) & 0xff;
  bytes[1] = seed & 0xff;
  return StrKey.encodeEd25519PublicKey(Buffer.from(bytes));
}

function Probe() {
  const { viewed, pendingWatch, confirmPendingWatch, dismissPendingWatch } = useViewedAddress();
  return (
    <div>
      <span data-testid="viewed">{viewed ?? "none"}</span>
      <span data-testid="pending">{pendingWatch ?? "none"}</span>
      <button type="button" onClick={confirmPendingWatch}>View</button>
      <button type="button" onClick={dismissPendingWatch}>Dismiss</button>
    </div>
  );
}

function renderWithProvider() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <ViewedAddressProvider>
        <Probe />
      </ViewedAddressProvider>
    </QueryClientProvider>,
  );
}

describe("ViewedAddressProvider ?watch= interstitial", () => {
  const addrA = makeAccount(11);
  const addrB = makeAccount(22);

  beforeEach(() => {
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/portfolio");
  });

  it("stages external ?watch= as pendingWatch instead of switching silently, and switches on confirm", () => {
    window.history.replaceState(null, "", `/portfolio?watch=${addrA}`);
    renderWithProvider();

    expect(screen.getByTestId("viewed").textContent).toBe("none");
    expect(screen.getByTestId("pending").textContent).toBe(addrA);

    fireEvent.click(screen.getByText("View"));
    expect(screen.getByTestId("viewed").textContent).toBe(addrA);
    expect(screen.getByTestId("pending").textContent).toBe("none");
  });

  it("restores sessionStorage watch silently without triggering pendingWatch", () => {
    window.sessionStorage.setItem("oracledesk_watch", addrB);
    renderWithProvider();

    expect(screen.getByTestId("viewed").textContent).toBe(addrB);
    expect(screen.getByTestId("pending").textContent).toBe("none");
  });
});
