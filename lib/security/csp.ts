/**
 * Content-Security-Policy builder. Pure: the same function runs in
 * `next.config.ts` at build time and in unit tests. Origins are derived from
 * the configured endpoints, never hardcoded.
 */

export interface CspInputs {
  apiUrl: string;
  rpcUrl: string;
  ipfsGateway: string;
  x402Url: string;
  /** Per-request nonce, when a nonce-based policy is used. */
  nonce?: string;
  /** SHA-256 hashes for inline bootstrap scripts (static strategy). */
  scriptHashes?: string[];
  /** Report collector; omitted when empty. */
  reportUri?: string;
  dev: boolean;
}

/**
 * Wallet modules inject runtime styles and open popups/iframes. Each entry is
 * an origin the app cannot remove without breaking a wallet.
 */
export const WALLET_CONNECT_ORIGINS = [
  "https://relay.walletconnect.org", // WalletConnect relay (LOBSTR, Freighter Mobile)
  "wss://relay.walletconnect.org",
  "https://verify.walletconnect.org",
  "https://albedo.link", // Albedo signs in a popup
  "https://connect.trezor.io", // Trezor Connect iframe
  "https://suite.trezor.io",
];

export const WALLET_FRAME_ORIGINS = [
  "https://albedo.link",
  "https://connect.trezor.io",
  "https://suite.trezor.io",
];

/** `https://host[:port]`, `ws(s)://host[:port]` or null for an empty/invalid value. */
export function originOf(url: string): string | null {
  if (!url || !url.trim()) return null;
  try {
    const parsed = new URL(url);
    return parsed.origin;
  } catch {
    return null;
  }
}

/** Socket.io origin: same host/scheme as the API, with ws(s) instead of http(s). */
export function socketOriginOf(apiUrl: string): string | null {
  const origin = originOf(apiUrl);
  if (!origin) return null;
  return origin.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
}

function unique(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export function buildCsp(inputs: CspInputs): string {
  const api = originOf(inputs.apiUrl);
  const socket = socketOriginOf(inputs.apiUrl);
  const connect = unique([
    "'self'",
    api,
    socket,
    originOf(inputs.rpcUrl),
    originOf(inputs.ipfsGateway),
    originOf(inputs.x402Url),
    ...WALLET_CONNECT_ORIGINS,
  ]);

  const script = ["'self'", "'strict-dynamic'"];
  if (inputs.nonce) script.push(`'nonce-${inputs.nonce}'`);
  if (inputs.scriptHashes?.length) script.push(...inputs.scriptHashes);
  // Turbopack's dev HMR needs eval; production never gets it.
  if (inputs.dev) script.push("'unsafe-eval'");

  const style = ["'self'"];
  if (inputs.nonce) style.push(`'nonce-${inputs.nonce}'`);
  // React style props (style-src-attr) and twind's runtime injection need
  // inline styles; script-src stays free of unsafe-inline.
  style.push("'unsafe-inline'");

  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    ["script-src", script],
    ["style-src", style],
    ["style-src-attr", ["'unsafe-inline'"]],
    ["img-src", unique(["'self'", "data:", "blob:"])],
    ["font-src", ["'self'"]],
    ["connect-src", connect],
    ["frame-src", WALLET_FRAME_ORIGINS],
    ["frame-ancestors", ["'none'"]],
    ["base-uri", ["'none'"]],
    ["form-action", ["'self'"]],
    ["object-src", ["'none'"]],
  ];
  if (!inputs.dev) directives.push(["upgrade-insecure-requests", []]);
  if (inputs.reportUri) {
    directives.push(["report-uri", [inputs.reportUri]]);
    directives.push(["report-to", ["csp-endpoint"]]);
  }

  return directives
    .map(([name, values]) => (values.length ? `${name} ${values.join(" ")}` : name))
    .join("; ");
}
