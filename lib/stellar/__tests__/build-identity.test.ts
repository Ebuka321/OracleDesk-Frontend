import { afterEach, describe, expect, it, vi } from "vitest";

const CONTRACT = "CC4MMHWZ6ZRYAOQRR42KIIWNEZNFM4CWQ5Y4NNWTWNRUYH2O7E3SRK2O";
const RESOLVER = "CDDJU3PH6T3Z4O6EYLALXXB5XBFPYO2G5P5RBDEIZ7ZVN6V37OQSVYGR";
const OTHER_RECIPIENT = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

async function loadConfig() {
  vi.resetModules();
  return import("../config");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("build identity (Issue #122)", () => {
  it("marks the default deployment canonical with nothing overridden", async () => {
    const { BUILD_IDENTITY, IDENTITIES } = await loadConfig();
    expect(BUILD_IDENTITY.canonical).toBe(true);
    expect(BUILD_IDENTITY.overridden).toEqual([]);
    expect(IDENTITIES.marketCore.matchesManifest).toBe(true);
    expect(IDENTITIES.marketCore.source).toBe("manifest");
    expect(BUILD_IDENTITY.manifestCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("marks an env-overridden contract id as overridden", async () => {
    vi.stubEnv("NEXT_PUBLIC_MARKET_CORE_CONTRACT_ID", RESOLVER);
    const { BUILD_IDENTITY, IDENTITIES } = await loadConfig();
    expect(BUILD_IDENTITY.canonical).toBe(false);
    expect(BUILD_IDENTITY.overridden).toContain("marketCore");
    expect(IDENTITIES.marketCore.source).toBe("env");
    expect(IDENTITIES.marketCore.matchesManifest).toBe(false);
    // Untouched keys stay canonical.
    expect(IDENTITIES.usdc.matchesManifest).toBe(true);
  });

  it("keeps an env override that still equals the manifest canonical", async () => {
    vi.stubEnv("NEXT_PUBLIC_MARKET_CORE_CONTRACT_ID", CONTRACT);
    const { BUILD_IDENTITY } = await loadConfig();
    expect(BUILD_IDENTITY.canonical).toBe(true);
    expect(BUILD_IDENTITY.overridden).toEqual([]);
  });

  it("flags a payments recipient equal to the treasury as the documented default", async () => {
    const { CONTRACTS, IDENTITIES } = await loadConfig();
    expect(IDENTITIES.paymentsRecipient.address).toBe(CONTRACTS.treasury);
    expect(IDENTITIES.paymentsRecipient.matchesManifest).toBe(true);
  });

  it("flags a non-treasury payments recipient as overridden", async () => {
    vi.stubEnv("NEXT_PUBLIC_PAYMENTS_RECIPIENT", OTHER_RECIPIENT);
    const { BUILD_IDENTITY, IDENTITIES } = await loadConfig();
    expect(IDENTITIES.paymentsRecipient.matchesManifest).toBe(false);
    expect(IDENTITIES.paymentsRecipient.source).toBe("env");
    expect(BUILD_IDENTITY.overridden).toContain("paymentsRecipient");
    expect(BUILD_IDENTITY.canonical).toBe(false);
  });

  it("treats a network without a manifest as non-canonical", async () => {
    vi.stubEnv("NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE", "Public Global Stellar Network ; September 2015");
    const { BUILD_IDENTITY } = await loadConfig();
    expect(BUILD_IDENTITY.canonical).toBe(false);
    expect(BUILD_IDENTITY.overridden.length).toBeGreaterThan(0);
  });
});
