import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ViewedAddressProvider } from "@/lib/hooks/useViewedAddress";
import { ViewingBanner } from "@/components/layout/ViewingBanner";

vi.mock("@/lib/contexts/WalletContext", () => ({
  useWalletAddress: () => ({ address: null, isConnected: false }),
}));

const WATCHED = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";

describe("ViewedAddressProvider hydration", () => {
  it("hydrates with ?watch= without any React hydration mismatch warning", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (
      <QueryClientProvider client={qc}>
        <ViewedAddressProvider>
          <ViewingBanner />
          <div id="content">ok</div>
        </ViewedAddressProvider>
      </QueryClientProvider>
    );

    const serverHtml = renderToString(tree);
    expect(serverHtml).not.toContain("Watch-Only Mode");

    const container = document.createElement("div");
    container.innerHTML = serverHtml;
    document.body.appendChild(container);

    window.history.replaceState(null, "", `/portfolio?watch=${WATCHED}`);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    let root: ReturnType<typeof hydrateRoot> | null = null;
    try {
      await act(async () => {
        root = hydrateRoot(container, tree);
      });
      expect(errorSpy).not.toHaveBeenCalled();
      expect(container.textContent).toContain("Watch-Only Mode");
    } finally {
      await act(async () => {
        root?.unmount();
      });
      container.remove();
      errorSpy.mockRestore();
      window.sessionStorage.removeItem("oracledesk_watch");
      window.history.replaceState(null, "", "/");
    }
  });
});
