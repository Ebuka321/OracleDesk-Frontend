import { StrKey } from "@stellar/stellar-sdk";
import { parseUsdc } from "../stellar/units";

/**
 * Pure validation for the public configuration. Used at module load in
 * `lib/stellar/config.ts`, by `next.config.ts` before a build starts, and by
 * `scripts/check-env-example.mjs` against `.env.example`.
 *
 * No I/O: every check is a function of the values passed in, so it runs in
 * Node and in the browser.
 */

export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
export const FUTURENET_PASSPHRASE = "Test SDF Future Network ; October 2022";
export const PUBLIC_PASSPHRASE = "Public Global Stellar Network ; September 2015";

export const DEFAULT_RPC_URL = "https://soroban-testnet.stellar.org";
export const DEFAULT_EXPLORER_URL = "https://stellar.expert/explorer/testnet";
export const DEFAULT_IPFS_GATEWAY = "https://ipfs.io/ipfs";
export const DEFAULT_IPFS_MAX_TRACE_BYTES = 1024 * 1024;
export const DEFAULT_API_URL = "http://localhost:8000/api/v1";
export const DEFAULT_DAILY_PASS_PRICE = "0.5";
export const MAX_IPFS_GATEWAYS = 5;

export type NodeEnv = "development" | "production" | "test";
export type ContractKey = "marketCore" | "treasury" | "resolver" | "reasoningRegistry" | "usdc";

export type ContractId = string & { readonly __brand: "ContractId" };
export type AccountAddress = string & { readonly __brand: "AccountAddress" };
export type ContractOrAccount = string & { readonly __brand: "ContractOrAccount" };
export type UrlString = string & { readonly __brand: "UrlString" };

export interface RawConfig {
  apiUrl?: string;
  passphrase?: string;
  rpcUrl?: string;
  rpcUrls?: string;
  explorerUrl?: string;
  contracts: Partial<Record<ContractKey, string | undefined>>;
  paymentsRecipient?: string;
  adminAddresses?: string;
  ipfsGateway?: string;
  x402Url?: string;
  dailyPassPriceUsdc?: string;
  nodeEnv: NodeEnv;
}

export interface ValidConfig {
  apiUrl: UrlString;
  passphrase: string;
  rpcUrl: UrlString;
  rpcUrls: UrlString[];
  explorerUrl: UrlString;
  contracts: Record<ContractKey, ContractId>;
  paymentsRecipient: ContractOrAccount;
  adminAddresses: AccountAddress[];
  ipfsGateways: UrlString[];
  x402Url: UrlString | "";
  dailyPassPriceUsdc: string;
  dailyPassPriceRaw: bigint;
  nodeEnv: NodeEnv;
}

export interface ConfigProblem {
  key: string;
  /** Already redacted when the value looks like a secret seed. */
  value: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; config: ValidConfig; problems: []; warnings: ConfigProblem[] }
  | { ok: false; config: null; problems: ConfigProblem[]; warnings: ConfigProblem[] };

/** Hosts whose passphrase is publicly known. Unknown hosts are a warning, not an error. */
const KNOWN_RPC: Record<string, string> = {
  "soroban-testnet.stellar.org": TESTNET_PASSPHRASE,
  "rpc-futurenet.stellar.org": FUTURENET_PASSPHRASE,
  "soroban-mainnet.stellar.org": PUBLIC_PASSPHRASE,
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const SECRET_SEED = /^S[A-Z2-7]{55}$/;

export function looksLikeSecret(value: string | undefined): boolean {
  return Boolean(value && SECRET_SEED.test(value.trim()));
}

/** Printable, redacted form of a value for error messages. */
export function describeValue(value: string | undefined): string {
  if (!value || !value.trim()) return "(unset)";
  if (looksLikeSecret(value)) return "S…(redacted)";
  const trimmed = value.trim();
  const shown = trimmed.length > 24 ? `${trimmed.slice(0, 21)}…` : trimmed;
  return JSON.stringify(shown);
}

function problem(key: string, value: string | undefined, message: string): ConfigProblem {
  return { key, value: describeValue(value), message };
}

function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname);
}

export interface CheckUrlOptions {
  /** An empty value is accepted (the caller decides what it means). */
  allowEmpty?: boolean;
  /** A non-root path is accepted. */
  allowPath?: boolean;
}

/** Checks a base URL: parseable, https (http only for loopback), no credentials/query/fragment. */
export function checkUrl(key: string, value: string, opts: CheckUrlOptions = {}): ConfigProblem | null {
  if (!value.trim()) return opts.allowEmpty ? null : problem(key, value, "is required");
  if (looksLikeSecret(value)) return problem(key, value, "looks like a secret seed; remove it and rotate the key");

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return problem(key, value, "is not a valid URL");
  }

  const local = isLocalHost(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    return problem(key, value, "must use https (http is allowed only for localhost, 127.0.0.1 or [::1])");
  }
  if (url.username || url.password) return problem(key, value, "must not include credentials");
  if (url.search) return problem(key, value, "must not include a query string");
  if (url.hash) return problem(key, value, "must not include a fragment");
  if (!opts.allowPath && url.pathname !== "/" && url.pathname !== "") {
    return problem(key, value, "must not include a path");
  }
  return null;
}

function required(value: string | undefined): value is string {
  return Boolean(value && value.trim());
}

/** `C…` contract id. */
export function checkContractId(key: string, value: string): ConfigProblem | null {
  if (!value.trim()) return problem(key, value, "is required");
  if (looksLikeSecret(value)) return problem(key, value, "looks like a secret seed; remove it and rotate the key");
  if (value.trim().startsWith("G")) return problem(key, value, "is a G… account address, not a contract id (C…)");
  if (value.trim().startsWith("M")) return problem(key, value, "is a muxed address; contract ids must be C…");
  try {
    if (StrKey.isValidContract(value.trim())) return null;
  } catch {
    // fall through to the message below
  }
  return problem(key, value, "is not a valid contract id (StrKey C…)");
}

/** `G…` account or `C…` contract. Muxed `M…` addresses are rejected. */
export function checkAccountOrContract(key: string, value: string): ConfigProblem | null {
  if (!value.trim()) return problem(key, value, "is required");
  if (looksLikeSecret(value)) return problem(key, value, "looks like a secret seed; remove it and rotate the key");
  const trimmed = value.trim();
  try {
    if (StrKey.isValidEd25519PublicKey(trimmed) || StrKey.isValidContract(trimmed)) return null;
  } catch {
    // fall through to the message below
  }
  if (StrKey.isValidMed25519PublicKey?.(trimmed)) {
    return problem(key, value, "is a muxed (M…) address; token transfers need a plain G… or C… address");
  }
  return problem(key, value, "is not a valid G… account or C… contract address");
}

/** `G…` only: contract accounts cannot sign a SEP-10 challenge. */
export function checkAccount(key: string, value: string): ConfigProblem | null {
  if (!value.trim()) return problem(key, value, "is required");
  if (looksLikeSecret(value)) return problem(key, value, "looks like a secret seed; remove it and rotate the key");
  const trimmed = value.trim();
  if (trimmed.startsWith("C")) return problem(key, value, "must be a G… account address (contracts cannot sign a SEP-10 challenge)");
  if (trimmed.startsWith("M")) return problem(key, value, "is a muxed address; admin addresses must be G…");
  try {
    if (StrKey.isValidEd25519PublicKey(trimmed)) return null;
  } catch {
    // fall through
  }
  return problem(key, value, "is not a valid G… account address");
}

/**
 * Parses a comma-separated gateway pool. Only https URLs are kept (plain http
 * only for localhost). Entries are de-duplicated, trailing slashes removed,
 * and the pool is capped at MAX_IPFS_GATEWAYS.
 */
export function parseGateways(raw: string | undefined): string[] {
  const gateways: string[] = [];
  for (const entry of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      continue;
    }
    const local = isLocalHost(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) continue;
    const normalized = url.toString().replace(/\/+$/, "");
    if (!gateways.includes(normalized)) gateways.push(normalized);
    if (gateways.length === MAX_IPFS_GATEWAYS) break;
  }
  return gateways;
}

function knownPassphraseFor(rpcUrl: string): string | null {
  try {
    return KNOWN_RPC[new URL(rpcUrl).hostname] ?? null;
  } catch {
    return null;
  }
}

function explorerNetwork(pathname: string): "testnet" | "public" | null {
  if (pathname.includes("/explorer/testnet")) return "testnet";
  if (pathname.includes("/explorer/public")) return "public";
  return null;
}

function rpcProblems(key: string, value: string | undefined, passphrase: string, warnings: ConfigProblem[]): ConfigProblem[] {
  if (!required(value)) return [];
  const problems: ConfigProblem[] = [];
  for (const entry of value.split(",").map((s) => s.trim()).filter(Boolean)) {
    const urlProblem = checkUrl(key, entry, { allowPath: true });
    if (urlProblem) {
      problems.push(urlProblem);
      continue;
    }
    const known = knownPassphraseFor(entry);
    if (known && known !== passphrase) {
      problems.push(problem(key, entry, `has passphrase ${JSON.stringify(known)} but NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE is ${JSON.stringify(passphrase)}`));
    } else if (!known) {
      warnings.push(problem(key, entry, "is not a known Stellar RPC host; passphrase consistency was not checked"));
    }
  }
  return problems;
}

export function validateConfig(raw: RawConfig): ValidationResult {
  const problems: ConfigProblem[] = [];
  const warnings: ConfigProblem[] = [];
  const env = raw.nodeEnv;

  // API URL: required for production builds, localhost default in development/test.
  const apiRaw = raw.apiUrl?.trim() ?? "";
  let apiUrl: string;
  if (!apiRaw) {
    if (env === "production") {
      problems.push(problem("NEXT_PUBLIC_API_URL", raw.apiUrl, "is required for production builds"));
      apiUrl = DEFAULT_API_URL;
    } else {
      apiUrl = DEFAULT_API_URL;
    }
  } else {
    apiUrl = apiRaw;
    const urlProblem = checkUrl("NEXT_PUBLIC_API_URL", apiRaw, { allowPath: true });
    if (urlProblem) problems.push(urlProblem);
    if (!/\/api\/v1\/?$/.test(apiRaw)) {
      problems.push(problem("NEXT_PUBLIC_API_URL", apiRaw, "must end with /api/v1 to match docs/api.md"));
    }
  }

  const passphrase = raw.passphrase?.trim() || TESTNET_PASSPHRASE;
  const rpcUrl = raw.rpcUrl?.trim() || DEFAULT_RPC_URL;
  if (raw.rpcUrl?.trim()) {
    const urlProblem = checkUrl("NEXT_PUBLIC_STELLAR_RPC_URL", rpcUrl, { allowPath: true });
    if (urlProblem) problems.push(urlProblem);
  }
  const known = knownPassphraseFor(rpcUrl);
  if (known && known !== passphrase) {
    problems.push(problem("NEXT_PUBLIC_STELLAR_RPC_URL", rpcUrl, `has passphrase ${JSON.stringify(known)} but NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE is ${JSON.stringify(passphrase)}`));
  } else if (!known) {
    warnings.push(problem("NEXT_PUBLIC_STELLAR_RPC_URL", rpcUrl, "is not a known Stellar RPC host; passphrase consistency was not checked"));
  }
  const extraRpc = raw.rpcUrls?.trim() ? raw.rpcUrls : undefined;
  problems.push(...rpcProblems("NEXT_PUBLIC_STELLAR_RPC_URLS", extraRpc, passphrase, warnings));
  const rpcUrls = (raw.rpcUrls ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((entry) => !checkUrl("NEXT_PUBLIC_STELLAR_RPC_URLS", entry, { allowPath: true }))
    .filter((entry, index, all) => all.indexOf(entry) === index && entry !== rpcUrl);

  const explorerUrl = raw.explorerUrl?.trim() || DEFAULT_EXPLORER_URL;
  if (raw.explorerUrl?.trim()) {
    const urlProblem = checkUrl("NEXT_PUBLIC_STELLAR_EXPLORER_URL", explorerUrl, { allowPath: true });
    if (urlProblem) problems.push(urlProblem);
  }
  try {
    const explorer = new URL(explorerUrl);
    const network = explorerNetwork(explorer.pathname);
    if (network === "testnet" && passphrase === PUBLIC_PASSPHRASE) {
      problems.push(problem("NEXT_PUBLIC_STELLAR_EXPLORER_URL", explorerUrl, "points at the testnet explorer but the passphrase is mainnet"));
    } else if (network === "public" && passphrase !== PUBLIC_PASSPHRASE) {
      problems.push(problem("NEXT_PUBLIC_STELLAR_EXPLORER_URL", explorerUrl, "points at the public explorer but the passphrase is not mainnet"));
    } else if (!network && explorer.hostname.endsWith("stellar.expert")) {
      warnings.push(problem("NEXT_PUBLIC_STELLAR_EXPLORER_URL", explorerUrl, "does not select /explorer/testnet or /explorer/public"));
    }
  } catch {
    // checkUrl already reported it
  }

  // Contracts: every id is a StrKey C… value and no two roles share an id.
  const contracts: Partial<Record<ContractKey, ContractId>> = {};
  const seen = new Map<string, ContractKey>();
  (Object.keys(raw.contracts) as ContractKey[]).forEach((key) => {
    const value = raw.contracts[key];
    const envKey = `NEXT_PUBLIC_${key === "marketCore" ? "MARKET_CORE" : key === "reasoningRegistry" ? "REASONING_REGISTRY" : key.toUpperCase()}_CONTRACT_ID`;
    if (!required(value)) {
      problems.push(problem(envKey, value, "is required (no deployment default)"));
      return;
    }
    const idProblem = checkContractId(envKey, value);
    if (idProblem) {
      problems.push(idProblem);
      return;
    }
    const id = value.trim();
    const duplicate = seen.get(id);
    if (duplicate) {
      problems.push(problem(envKey, value, `is the same id as ${duplicate}; contract roles must be distinct`));
      return;
    }
    seen.set(id, key);
    contracts[key] = id as ContractId;
  });

  const paymentsRecipient = raw.paymentsRecipient?.trim();
  if (!required(paymentsRecipient)) {
    problems.push(problem("NEXT_PUBLIC_PAYMENTS_RECIPIENT", raw.paymentsRecipient, "is required"));
  } else {
    const recipientProblem = checkAccountOrContract("NEXT_PUBLIC_PAYMENTS_RECIPIENT", paymentsRecipient);
    if (recipientProblem) problems.push(recipientProblem);
  }

  const adminAddresses: AccountAddress[] = [];
  for (const entry of (raw.adminAddresses ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const adminProblem = checkAccount("NEXT_PUBLIC_ADMIN_ADDRESSES", entry);
    if (adminProblem) problems.push(adminProblem);
    else adminAddresses.push(entry as AccountAddress);
  }

  const ipfsGateways: UrlString[] = [];
  const ipfsRaw = raw.ipfsGateway?.trim() ?? "";
  if (ipfsRaw) {
    for (const entry of ipfsRaw.split(",").map((s) => s.trim()).filter(Boolean)) {
      const urlProblem = checkUrl("NEXT_PUBLIC_IPFS_GATEWAY_URL", entry, { allowPath: true });
      if (urlProblem) {
        problems.push(urlProblem);
        continue;
      }
      if (!new URL(entry).pathname.replace(/\/+$/, "").endsWith("/ipfs")) {
        problems.push(problem("NEXT_PUBLIC_IPFS_GATEWAY_URL", entry, "must end with /ipfs"));
      }
    }
    ipfsGateways.push(...(parseGateways(ipfsRaw) as UrlString[]));
  }
  if (!ipfsGateways.length) ipfsGateways.push(DEFAULT_IPFS_GATEWAY as UrlString);

  const x402Url = raw.x402Url?.trim() ?? "";
  if (x402Url) {
    const urlProblem = checkUrl("NEXT_PUBLIC_X402_URL", x402Url, { allowEmpty: true, allowPath: true });
    if (urlProblem) problems.push(urlProblem);
  }

  const dailyPassPriceUsdc = raw.dailyPassPriceUsdc?.trim() || DEFAULT_DAILY_PASS_PRICE;
  let dailyPassPriceRaw = 0n;
  try {
    dailyPassPriceRaw = parseUsdc(dailyPassPriceUsdc);
    if (dailyPassPriceRaw <= 0n) {
      problems.push(problem("NEXT_PUBLIC_DAILY_PASS_PRICE_USDC", dailyPassPriceUsdc, "must be greater than zero"));
    }
  } catch {
    problems.push(problem("NEXT_PUBLIC_DAILY_PASS_PRICE_USDC", dailyPassPriceUsdc, "must be a decimal USDC amount like 0.5"));
  }

  if (problems.length) {
    return { ok: false, config: null, problems, warnings };
  }

  return {
    ok: true,
    problems: [],
    warnings,
    config: {
      apiUrl: apiUrl as UrlString,
      passphrase,
      rpcUrl: rpcUrl as UrlString,
      rpcUrls: rpcUrls as UrlString[],
      explorerUrl: explorerUrl as UrlString,
      contracts: contracts as Record<ContractKey, ContractId>,
      paymentsRecipient: paymentsRecipient as ContractOrAccount,
      adminAddresses,
      ipfsGateways,
      x402Url: (x402Url || "") as UrlString | "",
      dailyPassPriceUsdc,
      dailyPassPriceRaw,
      nodeEnv: env,
    },
  };
}

/** One readable block listing every problem, for `throw new Error(...)`. */
export function formatProblems(problems: readonly ConfigProblem[]): string {
  const lines = problems.map((p) => `  ${p.key.padEnd(44)} ${p.value}  ${p.message}`);
  return [`Invalid OracleDesk configuration (${problems.length} problem${problems.length === 1 ? "" : "s"}):`, ...lines].join("\n");
}
