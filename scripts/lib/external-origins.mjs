/**
 * Pure helpers for scripts/check-external-origins.mjs. The build output is
 * scanned for origins outside the configured API/RPC/IPFS/x402/explorer set.
 */

/** Unescape the URL escaping Next emits in RSC payloads (`https:\/\/`). */
export function normalizeEscapes(text) {
  return text.replace(/\\\//g, "/");
}

const URL_PATTERN =
  /https?:\/\/[^\s"'`<>)\\]+|(?<!:)\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s"'`<>)\\]+/gi;

export function originOf(value) {
  try {
    const withScheme = value.startsWith("//") ? `https:${value}` : value;
    return new URL(withScheme).origin;
  } catch {
    return null;
  }
}

/** Every origin-like URL in `text`, with its index. */
export function extractUrls(text) {
  const normalized = normalizeEscapes(text);
  const found = [];
  for (const match of normalized.matchAll(URL_PATTERN)) {
    const url = match[0].replace(/[.,;:]+$/, "");
    const origin = originOf(url);
    if (!origin) continue;
    found.push({ url, origin, index: match.index ?? 0 });
  }
  return found;
}

const FETCH_LIKE = /(?:src\s*=|href\s*=|url\s*\(|@import)/i;

/** A URL is fetch-like when it appears as an asset reference, not a plain string. */
export function isFetchLike(text, index) {
  const before = text.slice(Math.max(0, index - 48), index);
  if (FETCH_LIKE.test(before)) return true;
  const after = text.slice(index, index + 80);
  return /^[^"'`]*["'`]\s*(?:>|\);?)/.test(after) && /<(?:link|script|img)\b/i.test(before);
}

/**
 * Origins allowed by the app configuration. Defaults mirror
 * lib/config/validate.ts so the checker never needs the TypeScript build.
 */
export function configuredOrigins(env = process.env) {
  const api = env.NEXT_PUBLIC_API_URL?.trim() || "http://localhost:8000/api/v1";
  const rpc = env.NEXT_PUBLIC_STELLAR_RPC_URL?.trim() || "https://soroban-testnet.stellar.org";
  const explorer = env.NEXT_PUBLIC_STELLAR_EXPLORER_URL?.trim() || "https://stellar.expert/explorer/testnet";
  const gateways = (env.NEXT_PUBLIC_IPFS_GATEWAY_URL?.trim() || "https://ipfs.io/ipfs,https://dweb.link/ipfs,https://gateway.pinata.cloud/ipfs")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const extraRpc = (env.NEXT_PUBLIC_STELLAR_RPC_URLS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const x402 = env.NEXT_PUBLIC_X402_URL?.trim();
  const socket = api.replace(/^http:/, "ws:").replace(/^https:/, "wss:");

  return new Set(
    [api, socket, rpc, ...extraRpc, explorer, ...gateways, x402]
      .map((value) => (value ? originOf(value) : null))
      .filter(Boolean),
  );
}

/**
 * Findings for one file's text. `kind` is "error" for fetch-like contexts and
 * "warning" for plain string literals unless `strict` is set.
 */
export function findFindings(text, { allowedOrigins = new Set(), allowlist = {}, strict = false, fetchLikeErrors = true } = {}) {
  const normalized = normalizeEscapes(text);
  const findings = [];
  for (const { url, origin, index } of extractUrls(normalized)) {
    if (allowedOrigins.has(origin) || allowlist[origin]) continue;
    const fetchLike = isFetchLike(normalized, index);
    findings.push({
      url,
      origin,
      index,
      line: normalized.slice(0, index).split("\n").length,
      context: fetchLike ? "fetch-like" : "string",
      kind: (fetchLike && fetchLikeErrors) || strict ? "error" : "warning",
    });
  }
  return findings;
}

export function parseAllowlist(json) {
  const entries = Array.isArray(json) ? json : [];
  const byOrigin = {};
  for (const entry of entries) {
    if (!entry || typeof entry.origin !== "string" || typeof entry.reason !== "string" || !entry.reason.trim()) {
      throw new Error("Each allowlist entry needs an origin and a non-empty reason");
    }
    byOrigin[originOf(entry.origin)] = entry.reason;
  }
  return byOrigin;
}
