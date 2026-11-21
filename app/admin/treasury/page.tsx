"use client";

import React from "react";
import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { RequireWallet } from "@/components/require-wallet";
import { useWallet } from "@/lib/contexts/WalletContext";
import { isAdminAddress } from "@/lib/stellar/config";
import { TreasuryConsole } from "@/components/admin/treasury-console";

export default function AdminTreasuryPage() {
  return (
    <RequireWallet
      title="Restricted Access"
      description="The Treasury Operations Console requires an authenticated multi-signer admin wallet connection."
    >
      <TreasuryContent />
    </RequireWallet>
  );
}

function TreasuryContent() {
  const { address, disconnect, openModal } = useWallet();
  const isAuthorized = isAdminAddress(address);

  if (!isAuthorized) {
    return (
      <main className="flex-grow flex items-center justify-center p-gutter">
        <div className="max-w-md w-full text-center space-y-6 bg-white p-10 rounded-xl border border-outline-variant shadow-sm">
          <div className="w-20 h-20 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto">
            <Icon name="block" className="text-4xl" />
          </div>
          <div className="space-y-2">
            <h2 className="font-headline-md text-headline-md">Access Denied</h2>
            <p className="text-on-surface-variant text-sm">
              Your wallet address is not in the configured admin allowlist. Privileged operations are restricted to designated team keys.
            </p>
            <p className="text-on-surface-variant text-xs mt-4 font-data-mono break-all">
              {address}
            </p>
          </div>
          <button
            onClick={() => void disconnect().then(() => openModal())}
            className="w-full bg-outline text-on-outline py-3 rounded-lg font-label-caps text-label-caps hover:brightness-90 transition-all flex items-center justify-center gap-2 cursor-pointer"
          >
            <Icon name="swap_horiz" />
            SWITCH WALLET
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="flex-grow max-w-container-max-width mx-auto px-gutter py-12 w-full space-y-8">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6 border-b border-outline-variant/60 pb-6">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Link href="/admin" className="text-primary hover:underline text-xs uppercase font-bold flex items-center gap-1">
              <Icon name="arrow_back" className="text-[14px]" />
              Admin Center
            </Link>
          </div>
          <h1 className="font-display-lg text-display-lg text-primary text-4xl">
            Treasury Operations Console
          </h1>
          <p className="text-on-surface-variant font-body-md text-body-md">
            Review, independently verify, co-sign and submit multi-signer operations for Treasury and Market Core.
          </p>
        </div>
      </div>

      <TreasuryConsole />
    </main>
  );
}
