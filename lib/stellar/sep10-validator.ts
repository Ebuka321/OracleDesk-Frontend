import { WebAuth } from "@stellar/stellar-sdk";
import type { LoginIdentity } from "./identity";

export interface SEP10Config {
  serverAccountIds: string[];
  networkPassphrase: string;
  homeDomain: string;
  webAuthDomain: string;
  expectedIdentity: LoginIdentity;
}

export function validateSEP10Challenge(
  xdr: string,
  config: SEP10Config,
): { ok: true } | { ok: false; error: string } {
  if (!config.serverAccountIds.length || !config.homeDomain || !config.webAuthDomain) {
    return { ok: false, error: "SEP-10 server keys and domains are not configured." };
  }

  for (const serverAccountId of config.serverAccountIds) {
    try {
      const challenge = WebAuth.readChallengeTx(
        xdr,
        serverAccountId,
        config.networkPassphrase,
        config.homeDomain,
        config.webAuthDomain,
      );
      const expectedAccount = config.expectedIdentity.subIdKind === "MUXED"
        ? config.expectedIdentity.display
        : config.expectedIdentity.account;
      if (challenge.clientAccountID !== expectedAccount) return { ok: false, error: "Challenge account does not match the requested identity." };
      if (config.expectedIdentity.subIdKind === "MEMO") {
        const memo = challenge.memo as unknown as { value?: unknown; toString?: () => string } | undefined;
        const memoValue = memo?.value?.toString() ?? memo?.toString?.();
        if (memoValue !== config.expectedIdentity.subId) {
          return { ok: false, error: "Challenge memo does not match the requested memo." };
        }
      } else if (challenge.memo) {
        return { ok: false, error: "Challenge contains an unexpected memo." };
      }
      return { ok: true };
    } catch {
      // Try the next server key for rotation.
    }
  }
  return { ok: false, error: "Challenge failed SEP-10 validation." };
}
