"use client";

import React, { type ReactNode } from "react";
import { WalletHarness, type FakeKit } from "@/components/__tests__/wallet-harness";
import { ViewedAddressProvider } from "@/lib/hooks/useViewedAddress";
import { RealtimeProvider } from "@/lib/realtime/RealtimeProvider";
import { HealthProvider } from "@/lib/health/HealthProvider";
import { InboxProvider } from "@/lib/notifications/InboxProvider";

export function AppHarness({ children, kit }: { children: ReactNode; kit: FakeKit }) {
  return (
    <WalletHarness kit={kit}>
      <ViewedAddressProvider>
        <RealtimeProvider>
          <HealthProvider>
            <InboxProvider>
              <div id="main-content" tabIndex={-1} className="flex-1 flex flex-col">
                {children}
              </div>
            </InboxProvider>
          </HealthProvider>
        </RealtimeProvider>
      </ViewedAddressProvider>
    </WalletHarness>
  );
}
