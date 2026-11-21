# Threat Model (initial)

**Status:** partial. This covers scope, assets, attacker profiles and one
trust boundary (login) as a starting frame for #280. The remaining
boundaries (trading, trace verification, x402, copy trade, admin), the
CI reference checker, and the PR checklist are not yet done — tracked
under #280.

## Scope & assumptions

Testnet only (see `docs/STATUS.md`). Contracts are the source of truth for
funds; the backend is display-only; IPFS gateways are trusted for nothing
(hash-checked). RPC state is verified by `lib/stellar/rpc-pool.ts` /
`lib/stellar/rpc-network-guard.ts`.

## Assets

User funds (USDC/XLM via signatures), signing intent, backend session (JWT),
payment journal integrity, trading-activity privacy, integrity of displayed
traces/probabilities, admin authority.

## Attacker profiles

Malicious/compromised backend; malicious IPFS gateway; lying RPC endpoint;
malicious wallet/browser extension; XSS via untrusted content; cross-tab
adversary (`BroadcastChannel`); phishing clones; supply-chain compromise;
shared-device user; network attacker.

## Boundary B1 — Login (SEP-10)

Flow: wallet → `requestChallenge` → `validateSEP10Challenge` → wallet
`signTransaction` → `verifyChallenge` → JWT storage → cross-tab sync.

| Threat | Mitigation (code ref) | Status | Issue |
|---|---|---|---|
| Forged challenge accepted | `lib/stellar/sep10-validator.ts#validateSEP10Challenge` checks XDR parse, network passphrase, backend `expiresAt`, ≥1 signature, exactly one `manageData` op | partial — does not verify the signature is the server's signing key, sequence number is 0, or op source is the client account | no issue yet |
| Session theft via XSS/other extension | JWT kept in `localStorage` (`lib/api/client.ts`) and mirrored on `BroadcastChannel("oracledesk-wallet-sync")` (`lib/api/cross-tab-sync.ts`) | gap — token readable by any script in-origin | #116 |

## Residual risks (not yet ranked/linked beyond B1)

SEP-10 missing signer/sequence/source checks (High); JWT in localStorage +
BroadcastChannel (Medium, #116). Full register for the other boundaries is
left for a follow-up PR.
