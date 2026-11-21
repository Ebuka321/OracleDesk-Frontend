import { StrKey } from "@stellar/stellar-sdk";

/**
 * Recipient validation for outcome-share transfers (#265). Shares sent to a
 * protocol contract, a muxed id or an unfunded account cannot be redeemed by
 * the recipient, so those are rejected before a transfer is built.
 */

export type RecipientWarning = "first-time" | "lookalike" | "contract-recipient";
export type RecipientCheck =
  | { ok: true; address: string; kind: "account" | "contract"; warnings: RecipientWarning[] }
  | { ok: false; reason: "invalid" | "muxed" | "self" | "protocol-contract" | "unfunded-account" };

export interface RecipientDeps {
  /** Contract ids that can never redeem shares (market-core, treasury, resolver, registry). */
  protocolContracts: readonly string[];
  /** Resolves whether a G account exists on the ledger. */
  accountExists(address: string): Promise<boolean>;
}

const lookalike = (a: string, b: string) => a !== b && a.slice(0, 4) === b.slice(0, 4) && a.slice(-4) === b.slice(-4);

export async function checkRecipient(input: string, from: string, history: readonly string[], deps: RecipientDeps): Promise<RecipientCheck> {
  const address = input.trim();
  if (address.startsWith("M")) return { ok: false, reason: "muxed" };
  const isAccount = StrKey.isValidEd25519PublicKey(address);
  const isContract = !isAccount && StrKey.isValidContract(address);
  if (!isAccount && !isContract) return { ok: false, reason: "invalid" };
  if (address === from) return { ok: false, reason: "self" };
  if (isContract && deps.protocolContracts.includes(address)) return { ok: false, reason: "protocol-contract" };
  if (isAccount && !(await deps.accountExists(address))) return { ok: false, reason: "unfunded-account" };

  const warnings: RecipientWarning[] = [];
  if (!history.includes(address)) warnings.push("first-time");
  if (history.some((h) => lookalike(h, address))) warnings.push("lookalike");
  if (isContract) warnings.push("contract-recipient");
  return { ok: true, address, kind: isAccount ? "account" : "contract", warnings };
}
