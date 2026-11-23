import { apiClient, clearAuthSession, getStoredSessionWallet, getStoredToken, storeAuthSession } from "./client";
import { identityKey, parseLoginIdentity, type LoginIdentity } from "../stellar/identity";

export interface AuthSession {
  token: string;
  userId: string;
  walletAddress: string;
}

export interface AuthChallenge {
  /** Base64 transaction envelope to sign with the wallet (never submitted). */
  transaction: string;
  networkPassphrase: string;
  expiresAt: string;
}

export async function requestChallenge(id: LoginIdentity | string, memo?: string | null) {
  const resolved = typeof id === "string" ? parseLoginIdentity(id, memo) : { ok: true as const, id };
  if (!resolved.ok) throw new Error(resolved.error);
  const body = {
    address: resolved.id.subIdKind === "MUXED" ? resolved.id.display : resolved.id.account,
    ...(resolved.id.subIdKind === "MEMO" ? { memo: resolved.id.subId } : {}),
  };
  const { data } = await apiClient.post<AuthChallenge>("/auth/challenge", body);
  return data;
}

export async function verifyChallenge(id: LoginIdentity | string, signed: string, memo?: string | null) {
  const resolved = typeof id === "string" ? parseLoginIdentity(id, memo) : { ok: true as const, id };
  if (!resolved.ok) throw new Error(resolved.error);
  const body = {
    address: resolved.id.subIdKind === "MUXED" ? resolved.id.display : resolved.id.account,
    ...(resolved.id.subIdKind === "MEMO" ? { memo: resolved.id.subId } : {}),
    signed,
  };
  const { data } = await apiClient.post<AuthSession>("/auth/verify", body);
  if (data.walletAddress !== resolved.id.account) {
    throw new Error("The login response did not match the base Stellar account.");
  }
  storeAuthSession({
    ...data,
    identityKey: identityKey(resolved.id),
    subId: resolved.id.subId,
    subIdKind: resolved.id.subIdKind,
  });
  return data;
}

/**
 * SEP-10 style login: the backend issues a challenge transaction, the wallet
 * signs it (signTransaction works in every Stellar wallet), the backend
 * verifies the signature and returns a JWT.
 */
export async function signInWithWallet(
  address: string | LoginIdentity,
  signTransaction: (xdr: string, networkPassphrase: string) => Promise<string>,
): Promise<AuthSession> {
  const resolved = typeof address === "string" ? parseLoginIdentity(address) : { ok: true as const, id: address };
  if (!resolved.ok) throw new Error(resolved.error);
  const challenge = await requestChallenge(resolved.id);
  const signed = await signTransaction(challenge.transaction, challenge.networkPassphrase);
  return verifyChallenge(resolved.id, signed);
}

export { clearAuthSession, getStoredSessionWallet, getStoredToken };
