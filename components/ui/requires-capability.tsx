"use client";

import React, { type ReactNode } from "react";
import { useContractCapabilities } from "@/lib/stellar/contract-check";
import type { Capability } from "@/lib/stellar/capability-registry";

export interface RequiresCapabilityProps {
  cap: Capability;
  fallback?: ReactNode;
  children: ReactNode;
}

/**
 * Gates UI on a resolved contract capability. Renders `fallback` (or null)
 * when the capability is unavailable on the deployed contracts.
 */
export function RequiresCapability({ cap, fallback = null, children }: RequiresCapabilityProps) {
  const { state, has } = useContractCapabilities();
  if (state === "loading" || !has(cap)) {
    return <>{fallback}</>;
  }
  return <>{children}</>;
}
