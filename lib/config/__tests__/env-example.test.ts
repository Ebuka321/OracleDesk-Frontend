import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import deployments from "@/lib/stellar/generated/deployments.testnet.json";
import { validateConfig, type RawConfig } from "../validate";

const EXAMPLE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".env.example");

function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    values[trimmed.slice(0, index)] = trimmed.slice(index + 1).trim();
  }
  return values;
}

const env = parseEnv(readFileSync(EXAMPLE, "utf8"));
const contract = (key: string, fallback: string) => env[key] || fallback;

const raw = (nodeEnv: RawConfig["nodeEnv"]): RawConfig => ({
  apiUrl: env.NEXT_PUBLIC_API_URL,
  passphrase: env.NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE,
  rpcUrl: env.NEXT_PUBLIC_STELLAR_RPC_URL,
  rpcUrls: env.NEXT_PUBLIC_STELLAR_RPC_URLS,
  explorerUrl: env.NEXT_PUBLIC_STELLAR_EXPLORER_URL,
  contracts: {
    marketCore: contract("NEXT_PUBLIC_MARKET_CORE_CONTRACT_ID", deployments.contracts.market_core),
    treasury: contract("NEXT_PUBLIC_TREASURY_CONTRACT_ID", deployments.contracts.treasury),
    resolver: contract("NEXT_PUBLIC_RESOLVER_CONTRACT_ID", deployments.contracts.resolver),
    reasoningRegistry: contract("NEXT_PUBLIC_REASONING_REGISTRY_CONTRACT_ID", deployments.contracts.reasoning_registry),
    usdc: contract("NEXT_PUBLIC_USDC_CONTRACT_ID", deployments.contracts.usdc),
  },
  paymentsRecipient: env.NEXT_PUBLIC_PAYMENTS_RECIPIENT || deployments.contracts.treasury,
  adminAddresses: env.NEXT_PUBLIC_ADMIN_ADDRESSES,
  ipfsGateway: env.NEXT_PUBLIC_IPFS_GATEWAY_URL,
  x402Url: env.NEXT_PUBLIC_X402_URL,
  dailyPassPriceUsdc: env.NEXT_PUBLIC_DAILY_PASS_PRICE_USDC,
  nodeEnv,
});

describe(".env.example", () => {
  it("is a valid development configuration", () => {
    const result = validateConfig(raw("development"));
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("is a valid production configuration (API URL is explicit)", () => {
    expect(validateConfig(raw("production")).ok).toBe(true);
  });
});
