import { MuxedAccount, StrKey } from "@stellar/stellar-sdk";

export type SubIdKind = "MUXED" | "MEMO";

export interface LoginIdentity {
  account: string;
  subId: string | null;
  subIdKind: SubIdKind | null;
  display: string;
}

export type LoginIdentityResult =
  | { ok: true; id: LoginIdentity }
  | { ok: false; error: string };

export function identityKey(id: LoginIdentity): string {
  if (id.subIdKind === "MUXED") return `${id.account}#muxed:${id.subId}`;
  if (id.subIdKind === "MEMO") return `${id.account}#memo:${id.subId}`;
  return id.account;
}

export function parseLoginIdentity(input: string, memo?: string | null): LoginIdentityResult {
  const value = input.trim();
  if (value.startsWith("M")) {
    if (memo) return { ok: false, error: "A muxed address cannot be combined with a memo." };
    try {
      if (!StrKey.isValidMed25519PublicKey(value)) throw new Error();
      const muxed = MuxedAccount.fromAddress(value, "0");
      return {
        ok: true,
        id: { account: muxed.baseAccount().accountId(), subId: muxed.id(), subIdKind: "MUXED", display: value },
      };
    } catch {
      return { ok: false, error: "Enter a valid M-address." };
    }
  }
  if (!StrKey.isValidEd25519PublicKey(value)) return { ok: false, error: "Enter a valid G-address." };
  if (memo !== undefined && memo !== null && memo !== "") {
    if (!/^(0|[1-9][0-9]*)$/.test(memo)) return { ok: false, error: "Memo must be a decimal uint64 string." };
    try {
      if (BigInt(memo) > 18446744073709551615n) throw new Error();
    } catch {
      return { ok: false, error: "Memo must be between 0 and 18446744073709551615." };
    }
    return { ok: true, id: { account: value, subId: memo, subIdKind: "MEMO", display: `${value}#${memo}` } };
  }
  return { ok: true, id: { account: value, subId: null, subIdKind: null, display: value } };
}
