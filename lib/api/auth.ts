import {
  API_URL,
  SESSION_MODE,
  apiClient,
  clearAuthSession,
  getStoredSessionWallet,
  getStoredToken,
  setConfirmedSessionWallet,
  setCsrfToken,
  storeAuthSession,
  isAuthError,
} from "./client";
import { validateSEP10Challenge, type SEP10ValidationError } from "@/lib/stellar/sep10-validator";
import { isTokenExpired, getTokenTTL, getReAuthPromise, setReAuthPromise, isReAuthInFlight, waitForReAuth } from "./jwt-manager";
import { broadcastSessionChange } from "./cross-tab-sync";
import { TransactionBuilder } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE } from "@/lib/stellar/config";
import { NetworkMismatchError } from "@/lib/stellar/network-check";
import { sha256Hex } from "@/lib/stellar/trace";
import { withOperation } from "@/lib/observability/tracing";

export interface AuthSession {
  token?: string;
  userId: string;
  walletAddress: string;
  csrfToken?: string;
  expiresAt?: string;
}

/** What `GET /auth/session` reports for the cookie. */
export interface ServerSession {
  walletAddress: string;
  userId: string;
  expiresAt?: string;
}

const LEGACY_TOKEN_KEY = "oracledesk_token";
const LEGACY_USER_KEY = "oracledesk_user_id";
const UPGRADE_FLAG = "oracledesk_cookie_upgraded";

/** A logout must finish before a new sign-in starts, or a late response clears the new cookie. */
let pendingLogout: Promise<void> = Promise.resolve();

export interface AuthChallenge {
  /** Base64 transaction envelope to sign with the wallet (never submitted). */
  transaction: string;
  networkPassphrase: string;
  expiresAt: string;
}

export async function requestChallenge(address: string, options?: ApiRequestOptions) {
  const { data } = await apiClient.post<AuthChallenge>("/auth/challenge", { address }, undefined, options);
  return data;
}

export async function verifyChallenge(address: string, signed: string, isCurrent: () => boolean = () => true) {
  const { data } = await apiClient.post<AuthSession>(
    "/auth/verify",
    { address, signed },
    SESSION_MODE === "cookie" ? { "X-Session-Mode": "cookie" } : undefined,
  );
  if (!isCurrent() || data.walletAddress !== address) throw new Error("Your account changed; sign in again.");
  storeAuthSession(data);
  setConfirmedSessionWallet(data.walletAddress);
  broadcastSessionChange(data.token ?? null, data.walletAddress);
  return data;
}

/**
 * Reads the server-confirmed session from the cookie (cookie mode) or from the
 * stored bearer token (bearer mode). Returns null for 401, so callers can show
 * "signed out" without treating it as an error.
 */
export async function getSession(): Promise<ServerSession | null> {
  if (SESSION_MODE === "bearer") {
    const wallet = getStoredSessionWallet();
    const token = getStoredToken();
    return token && wallet ? { walletAddress: wallet, userId: "" } : null;
  }
  try {
    const { data } = await apiClient.get<ServerSession>("/auth/session");
    setConfirmedSessionWallet(data.walletAddress);
    return data;
  } catch (error) {
    if (isAuthError(error)) {
      clearAuthSession();
      return null;
    }
    throw error;
  }
}

/** Clears the cookie session. Fire-and-forget callers may ignore the rejection. */
export function logout(): Promise<void> {
  if (SESSION_MODE === "bearer") {
    clearAuthSession();
    return Promise.resolve();
  }
  const run = pendingLogout
    .catch(() => undefined)
    .then(async () => {
      try {
        await apiClient.post("/auth/logout");
      } finally {
        clearAuthSession();
        broadcastSessionChange(null, null);
      }
    });
  pendingLogout = run.catch(() => undefined);
  return run;
}

/**
 * One-shot, silent migration of a legacy localStorage token to the cookie.
 * Deletes the legacy keys on success and on 401 (the token was dead); keeps
 * them on a network failure so a later load can retry.
 */
export async function migrateLegacySession(): Promise<void> {
  if (SESSION_MODE !== "cookie" || typeof window === "undefined") return;
  const storage = window.localStorage;
  const token = storage.getItem(LEGACY_TOKEN_KEY);
  if (!token) return;
  if (storage.getItem(UPGRADE_FLAG)) {
    storage.removeItem(LEGACY_TOKEN_KEY);
    storage.removeItem(LEGACY_USER_KEY);
    return;
  }
  try {
    const response = await fetch(`${API_URL.replace(/\/$/, "")}/auth/upgrade`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      credentials: "include",
    });
    if (response.ok) {
      const body = (await response.json().catch(() => null)) as
        | { data?: { walletAddress?: string; csrfToken?: string } }
        | null;
      const wallet = body?.data?.walletAddress;
      if (body?.data?.csrfToken) setCsrfToken(body.data.csrfToken);
      if (wallet) setConfirmedSessionWallet(wallet);
      storage.setItem(UPGRADE_FLAG, "1");
      storage.removeItem(LEGACY_TOKEN_KEY);
      storage.removeItem(LEGACY_USER_KEY);
      return;
    }
    if (response.status === 401 || response.status === 404) {
      storage.setItem(UPGRADE_FLAG, "1");
      storage.removeItem(LEGACY_TOKEN_KEY);
      storage.removeItem(LEGACY_USER_KEY);
    }
  } catch {
    // Offline: keep the legacy token so the next load can try again.
  }
}

/**
 * Validate SEP-10 challenge before signing.
 * Throws if the challenge is invalid or expired.
 */
export function validateChallenge(challenge: AuthChallenge): SEP10ValidationError | null {
  return validateSEP10Challenge(challenge, NETWORK_PASSPHRASE);
}

/** SHA-256 of the challenge XDR envelope (base64 decoded), sent as `X-Challenge-Hash`. */
async function challengeHash(transaction: string): Promise<string> {
  let bytes: Uint8Array;
  try {
    const binary = atob(transaction);
    bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    bytes = new TextEncoder().encode(transaction); // not base64: hash it as-is
  }
  return sha256Hex(bytes);
}

/**
 * SEP-10 style login: the backend issues a challenge transaction, the wallet
 * signs it (signTransaction works in every Stellar wallet), the backend
 * verifies the signature and returns a JWT.
 *
 * Validates the challenge before signing to prevent signing malformed transactions.
 *
 * Runs as one traced operation (issue #124): both requests share one
 * `traceparent`, and the verify request carries `X-Challenge-Hash` so the
 * backend can prove the signature it verifies is over the challenge it issued.
 */
export async function signInWithWallet(
  address: string,
  signTransaction: (xdr: string, networkPassphrase: string) => Promise<string>,
  isCurrent: () => boolean = () => true,
): Promise<AuthSession> {
  // Serialize logout → sign-in so a late logout response cannot clear the new cookie.
  await pendingLogout.catch(() => undefined);
  const challenge = await requestChallenge(address);

    if (challenge.networkPassphrase !== NETWORK_PASSPHRASE) {
      throw new NetworkMismatchError(NETWORK_PASSPHRASE, challenge.networkPassphrase);
    }
    // XDR does not itself encode a passphrase; parsing here ensures the envelope
    // is valid, and the exact advertised passphrase check above binds the hash.
    TransactionBuilder.fromXDR(challenge.transaction, NETWORK_PASSPHRASE);

    // Validate challenge before signing
    const validationError = validateChallenge(challenge);
    if (validationError) {
      throw new Error(`Invalid SEP-10 challenge: ${validationError.message}`);
    }

    if (!isCurrent()) throw new Error("Your account changed; sign in again.");
    const signed = await signTransaction(challenge.transaction, challenge.networkPassphrase);
    if (!isCurrent()) throw new Error("Your account changed; sign in again.");
    return verifyChallenge(address, signed, isCurrent, trace, {
      "X-Challenge-Hash": await challengeHash(challenge.transaction),
    });
  });
}

/**
 * Check if stored JWT is expired and needs refresh.
 * Useful for preemptive re-auth before making API calls.
 */
export function isStoredTokenExpired(): boolean {
  const token = getStoredToken();
  return !token || isTokenExpired(token);
}

/**
 * Get TTL of stored JWT (time until expiry in milliseconds).
 * Returns 0 if token is invalid or expired.
 */
export function getStoredTokenTTL(): number {
  const token = getStoredToken();
  return token ? getTokenTTL(token) : 0;
}

/**
 * Single-flight re-authentication: ensures only one re-auth request is in flight.
 * Subsequent calls wait for the first one to complete instead of spawning new requests.
 *
 * This prevents the "thundering herd" problem when many API calls fail with 401
 * simultaneously and all try to re-auth at once.
 */
export async function ensureAuthWithSingleFlight(
  address: string,
  signTransaction: (xdr: string, networkPassphrase: string) => Promise<string>,
): Promise<AuthSession> {
  // Check if re-auth is already in flight
  if (isReAuthInFlight()) {
    await waitForReAuth();
    // After waiting, return the current session (it may still fail if re-auth failed)
    const token = getStoredToken();
    const wallet = getStoredSessionWallet();
    if (!token || !wallet) throw new Error("Re-authentication failed");
    return { token: token ?? "", userId: "", walletAddress: wallet };
  }

  // Start new re-auth attempt
  const reAuthPromise = signInWithWallet(address, signTransaction);
  setReAuthPromise(reAuthPromise.then(() => undefined));

  try {
    const session = await reAuthPromise;
    setReAuthPromise(null);
    return session;
  } catch (error) {
    setReAuthPromise(null);
    throw error;
  }
}

export { clearAuthSession, getStoredSessionWallet, getStoredToken, isAuthError };
