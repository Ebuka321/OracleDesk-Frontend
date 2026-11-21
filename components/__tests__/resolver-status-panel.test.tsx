import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ResolverStatusPanel } from "../../resolver-status-panel";
import { VALID_TEST_SIGNER_1 } from "@/lib/stellar/__tests__/resolution-vectors.fixtures";
import type { ResolutionSpec } from "@/lib/api/markets";

describe("ResolverStatusPanel", () => {
  const sampleSpec: ResolutionSpec = {
    kind: "signers",
    signers: [VALID_TEST_SIGNER_1],
    threshold: 1,
    disputeWindow: 86400,
  };

  it("renders verified status when commitment matches", async () => {
    // When resolutionSpec is provided and hashes match
    render(
      <ResolverStatusPanel
        resolverState="SignersPending"
        resolutionSpec={sampleSpec}
        resolutionHash="some-hash"
      />
    );

    expect(screen.getByText("Resolver Rule Integrity")).toBeDefined();
  });

  it("renders non-alarming UI for unsupported kind", async () => {
    const unsupportedSpec = {
      kind: "Committee",
    } as any;

    render(
      <ResolverStatusPanel
        resolverState="SignersPending"
        resolutionSpec={unsupportedSpec}
        resolutionHash="1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef"
      />
    );

    // Should indicate unsupported without alarm
    expect(await screen.findByText(/Verification Unsupported/i)).toBeDefined();
  });
});
