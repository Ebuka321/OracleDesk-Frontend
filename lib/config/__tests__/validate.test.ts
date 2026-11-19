import { describe, expect, it } from "vitest";
import { StrKey } from "@stellar/stellar-sdk";
import deployments from "@/lib/stellar/generated/deployments.testnet.json";
import {
  DEFAULT_API_URL,
  FUTURENET_PASSPHRASE,
  TESTNET_PASSPHRASE,
  checkContractId,
  checkUrl,
  formatProblems,
  validateConfig,
  type RawConfig,
} from "../validate";

const CONTRACTS = {
  marketCore: deployments.contracts.market_core,
  treasury: deployments.contracts.treasury,
  resolver: deployments.contracts.resolver,
  reasoningRegistry: deployments.contracts.reasoning_registry,
  usdc: deployments.contracts.usdc,
};

const base = (overrides: Partial<RawConfig> = {}): RawConfig => ({
  apiUrl: "https://api.example.com/api/v1",
  rpcUrl: "https://soroban-testnet.stellar.org",
  explorerUrl: "https://stellar.expert/explorer/testnet",
  contracts: { ...CONTRACTS },
  paymentsRecipient: deployments.contracts.treasury,
  ipfsGateway: "https://ipfs.io/ipfs",
  dailyPassPriceUsdc: "0.5",
  nodeEnv: "production",
  ...overrides,
});

const contractSeed = (byte: number) => StrKey.encodeContract(Buffer.alloc(32, byte));

describe("validateConfig", () => {
  it("accepts the deployment defaults", () => {
    const result = validateConfig(base());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.apiUrl).toBe("https://api.example.com/api/v1");
    expect(result.config.contracts.marketCore).toBe(CONTRACTS.marketCore);
    expect(result.config.dailyPassPriceRaw).toBe(5_000_000n);
    expect(result.config.adminAddresses).toEqual([]);
  });

  it("defaults the API URL to localhost outside production", () => {
    const result = validateConfig(base({ apiUrl: undefined, nodeEnv: "development" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.apiUrl).toBe(DEFAULT_API_URL);
  });

  it("requires the API URL for production builds (no remote fallback)", () => {
    const result = validateConfig(base({ apiUrl: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.map((p) => p.key)).toContain("NEXT_PUBLIC_API_URL");
  });

  it("rejects a bad contract checksum", () => {
    const bad = `${CONTRACTS.marketCore.slice(0, -1)}X`;
    const result = validateConfig(base({ contracts: { ...CONTRACTS, marketCore: bad } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0].message).toMatch(/not a valid contract id/);
  });

  it("rejects a G address as a contract id", () => {
    expect(checkContractId("KEY", deployments.deployer)?.message).toMatch(/account address/);
  });

  it("rejects http RPC on a non-localhost host but allows localhost", () => {
    expect(checkUrl("RPC", "http://rpc.example.com")?.message).toMatch(/https/);
    expect(checkUrl("RPC", "http://localhost:8787/rpc", { allowPath: true })).toBeNull();
    expect(checkUrl("RPC", "http://[::1]:8787/rpc", { allowPath: true })).toBeNull();
  });

  it("rejects credentials, query strings and fragments", () => {
    expect(checkUrl("U", "https://user:pass@example.com")?.message).toMatch(/credentials/);
    expect(checkUrl("U", "https://example.com?token=1")?.message).toMatch(/query/);
    expect(checkUrl("U", "https://example.com#x")?.message).toMatch(/fragment/);
  });

  it("requires API_URL to end with /api/v1", () => {
    const result = validateConfig(base({ apiUrl: "https://api.example.com" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0].message).toMatch(/\/api\/v1/);
  });

  it("rejects a known testnet RPC paired with a different passphrase", () => {
    const result = validateConfig(base({ passphrase: "Public Global Stellar Network ; September 2015" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0].message).toMatch(/passphrase/);
  });

  it("warns about an unknown RPC host without failing", () => {
    const result = validateConfig(base({ rpcUrl: "https://rpc.example.com" }));
    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.key)).toContain("NEXT_PUBLIC_STELLAR_RPC_URL");
  });

  it("accepts futurenet with its passphrase", () => {
    expect(validateConfig(base({
      rpcUrl: "https://rpc-futurenet.stellar.org",
      passphrase: FUTURENET_PASSPHRASE,
      explorerUrl: "https://stellar.expert/explorer/testnet",
    })).ok).toBe(true);
  });

  it("requires a positive, parseable daily pass price", () => {
    expect(validateConfig(base({ dailyPassPriceUsdc: "0" })).ok).toBe(false);
    expect(validateConfig(base({ dailyPassPriceUsdc: "-1" })).ok).toBe(false);
    expect(validateConfig(base({ dailyPassPriceUsdc: "lots" })).ok).toBe(false);
    expect(validateConfig(base({ dailyPassPriceUsdc: "1.25" })).ok).toBe(true);
  });

  it("rejects duplicate contract ids", () => {
    const result = validateConfig(base({ contracts: { ...CONTRACTS, resolver: CONTRACTS.marketCore } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0].message).toMatch(/same id/);
  });

  it("requires admin addresses to be G accounts", () => {
    const result = validateConfig(base({ adminAddresses: `${deployments.deployer},${CONTRACTS.treasury}` }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0].message).toMatch(/SEP-10/);
  });

  it("rejects muxed recipients", () => {
    const muxed = StrKey.encodeMed25519PublicKey(Buffer.alloc(40, 1));
    const result = validateConfig(base({ paymentsRecipient: muxed }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0].message).toMatch(/muxed/);
  });

  it("redacts a secret seed and tells the user to rotate it", () => {
    const seed = StrKey.encodeEd25519SecretSeed(Buffer.alloc(32, 2));
    const result = validateConfig(base({ paymentsRecipient: seed }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(JSON.stringify(result.problems)).not.toContain(seed);
      expect(result.problems[0].value).toBe("S…(redacted)");
      expect(result.problems[0].message).toMatch(/rotate/);
    }
  });

  it("collects every problem in one pass", () => {
    const result = validateConfig(base({
      apiUrl: "http://api.example.com",
      rpcUrl: "http://rpc.example.com",
      contracts: { ...CONTRACTS, usdc: contractSeed(9).slice(0, -1) + "X" },
      adminAddresses: CONTRACTS.treasury,
      dailyPassPriceUsdc: "0",
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.length).toBeGreaterThanOrEqual(4);
      expect(formatProblems(result.problems)).toMatch(/Invalid OracleDesk configuration \(\d+ problems\)/);
    }
  });

  it("keeps testnet defaults valid without any environment", () => {
    const result = validateConfig({
      contracts: { ...CONTRACTS },
      paymentsRecipient: CONTRACTS.treasury,
      nodeEnv: "test",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.rpcUrl).toBe("https://soroban-testnet.stellar.org");
      expect(result.config.passphrase).toBe(TESTNET_PASSPHRASE);
      expect(result.config.ipfsGateways[0]).toBe("https://ipfs.io/ipfs");
    }
  });
});
