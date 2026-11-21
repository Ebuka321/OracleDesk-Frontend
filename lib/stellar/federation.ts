import { StrKey } from "@stellar/stellar-sdk";

/**
 * SEP-2 federation lookup (issue #268). A federation server only *proposes*
 * an account: callers must show the resolved G-address and have the user
 * confirm it, then store the raw key, never the federation name.
 */

export interface FederationRecord {
  stellarAddress: string;
  accountId: string;
  memoType?: "text" | "id" | "hash";
  memo?: string;
  domain: string;
  server: string;
}

export type FederationErrorCode =
  | "bad-name" | "no-toml" | "no-server" | "not-found" | "bad-response" | "timeout" | "offline" | "name-mismatch";

export class FederationError extends Error {
  constructor(readonly code: FederationErrorCode, message = code) { super(message); }
}

interface Deps { fetch?: typeof fetch; timeoutMs?: number }

const MAX_BODY = 4 * 1024;
const MAX_TOML = 100 * 1024;

/** Splits `user*domain` on the last `*`; returns null when either part is invalid. */
export function parseFederationName(s: string): { user: string; domain: string } | null {
  const trimmed = s.trim();
  const at = trimmed.lastIndexOf("*");
  if (at <= 0 || at === trimmed.length - 1) return null;
  const user = trimmed.slice(0, at);
  const rawDomain = trimmed.slice(at + 1);
  if (user.length > 64 || !/^[\x21-\x7e]+$/.test(user)) return null;
  if (/[/:@\s]/.test(rawDomain)) return null;
  let domain: string;
  try { domain = new URL(`https://${rawDomain}`).hostname.toLowerCase(); } catch { return null; }
  if (/^\d+(\.\d+){3}$/.test(domain) || domain.startsWith("[") || !domain.includes(".")) return null;
  return { user, domain };
}

async function fetchCapped(url: string, cap: number, deps: Deps): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 6000);
  try {
    const response = await (deps.fetch ?? fetch)(url, {
      credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal: controller.signal,
    });
    const text = await response.text();
    if (text.length > cap) throw new FederationError("bad-response", "Response too large.");
    return { status: response.status, text };
  } catch (error) {
    if (error instanceof FederationError) throw error;
    if (controller.signal.aborted) throw new FederationError("timeout");
    if (typeof navigator !== "undefined" && navigator.onLine === false) throw new FederationError("offline");
    throw new FederationError("bad-response", "Request failed (the server may not allow cross-origin requests).");
  } finally {
    clearTimeout(timer);
  }
}

/** Reads `FEDERATION_SERVER`; only an https URL on the domain or a subdomain is accepted. */
export function federationServerOf(toml: string, domain: string): string | null {
  const match = /^\s*FEDERATION_SERVER\s*=\s*"([^"]+)"\s*$/m.exec(toml);
  if (!match) return null;
  try {
    const url = new URL(match[1]);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (host !== domain && !host.endsWith(`.${domain}`)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function serverFor(domain: string, deps: Deps): Promise<string> {
  const toml = await fetchCapped(`https://${domain}/.well-known/stellar.toml`, MAX_TOML, deps)
    .catch((error) => { throw error instanceof FederationError && error.code !== "bad-response" ? error : new FederationError("no-toml"); });
  if (toml.status !== 200) throw new FederationError("no-toml");
  const server = federationServerOf(toml.text, domain);
  if (!server) throw new FederationError("no-server");
  return server;
}

async function query(server: string, q: string, type: "name" | "id", deps: Deps): Promise<Record<string, unknown> | null> {
  const { status, text } = await fetchCapped(`${server}?q=${encodeURIComponent(q)}&type=${type}`, MAX_BODY, deps);
  if (status === 404) return null;
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new FederationError("bad-response"); }
  if (!body || typeof body !== "object") throw new FederationError("bad-response");
  if (status !== 200 || "detail" in body) return null;
  return body as Record<string, unknown>;
}

function validMemo(type: unknown, memo: unknown): boolean {
  if (typeof memo !== "string") return false;
  if (type === "text") return new TextEncoder().encode(memo).length <= 28;
  if (type === "id") return /^\d{1,20}$/.test(memo) && BigInt(memo) <= 18446744073709551615n;
  if (type === "hash") return /^[0-9a-fA-F]{64}$/.test(memo) || /^[A-Za-z0-9+/]{43}=$/.test(memo);
  return false;
}

export async function resolveFederation(name: string, deps: Deps = {}): Promise<FederationRecord> {
  const parsed = parseFederationName(name);
  if (!parsed) throw new FederationError("bad-name");
  const requested = `${parsed.user}*${parsed.domain}`;
  const server = await serverFor(parsed.domain, deps);
  const body = await query(server, requested, "name", deps);
  if (!body) throw new FederationError("not-found");

  const returned = typeof body.stellar_address === "string" ? parseFederationName(body.stellar_address) : null;
  if (!returned || returned.domain !== parsed.domain || returned.user.toLowerCase() !== parsed.user.toLowerCase()) {
    throw new FederationError("name-mismatch");
  }
  const accountId = body.account_id;
  if (typeof accountId !== "string" || !StrKey.isValidEd25519PublicKey(accountId)) throw new FederationError("bad-response");

  const record: FederationRecord = { stellarAddress: requested, accountId, domain: parsed.domain, server };
  if (body.memo_type !== undefined || body.memo !== undefined) {
    if (!validMemo(body.memo_type, body.memo)) throw new FederationError("bad-response");
    record.memoType = body.memo_type as FederationRecord["memoType"];
    record.memo = body.memo as string;
  }
  return record;
}

/** Reverse lookup (`type=id`); informational only, never raises trust. */
export async function reverseFederation(accountId: string, domain: string, deps: Deps = {}): Promise<string | null> {
  const server = await serverFor(domain, deps);
  const body = await query(server, accountId, "id", deps).catch(() => null);
  return body && typeof body.stellar_address === "string" ? body.stellar_address : null;
}
