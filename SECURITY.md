# Security Policy

## Status: testnet only, unaudited

This frontend talks to OracleDesk contracts deployed on Stellar **testnet
only**. Nothing has been professionally audited. Don't use it with mainnet
funds or keys. See [docs/STATUS.md](docs/STATUS.md) for what is and isn't
verified.

## Reporting a vulnerability

Report privately, not in a public issue:

- [GitHub Security Advisories](../../security/advisories/new) for this
  repository, or
- email **SECURITY-CONTACT-TBD@example.invalid**

See [docs/threat-model.md](docs/threat-model.md) (in progress) for
attacker profiles, trust boundaries, and known mitigation gaps.
  <!-- TODO(maintainer): replace with the real private disclosure address. -->

<!-- TODO(maintainer): state a triage/response timeline once you have one. -->

In scope, for example:

- Anything that makes the app sign a transaction the user didn't intend
  (wrong contract, wrong amount, wrong recipient, missing slippage bound).
- Rendering reasoning-trace content that hasn't passed the hash check in
  `lib/stellar/trace.ts`.
- Leaking a secret through a `NEXT_PUBLIC_*` variable (these are compiled
  into browser JavaScript).
- URL or path injection from shared links, backend JSON, socket payloads or
  on-chain strings (`lib/validation/`).
- Reusing a backend session for a different wallet.
- Stealing a backend session from script-readable storage. The default cookie
  mode keeps the JWT in an `HttpOnly` cookie; the bearer mode exists only for
  cross-site deployments and stores the token in `localStorage`.

## Secret scanning

`npm run scan:secrets` runs after `npm run build` in CI and scans
`.next/static` and prerendered HTML/RSC payloads for Stellar secret seeds
(checksum-validated), EVM private keys, JWTs and known vendor key formats. It
also fails on any `NEXT_PUBLIC_*` name that is not listed in `.env.example`.
Findings print the file, position, detector and a SHA-256 prefix, never the
secret.

To allowlist a public value, add `{ "value_sha256": "<sha256>", "reason":
"..." }` to `scripts/scan-build-secrets.allow.json`; the deployment file's
contracts, deployer and agent are allowlisted automatically. Gitleaks runs on
PR diffs with `.gitleaks.toml`. If a real secret is found: rotate it first,
then remove it from code and history.

Out of scope: the contracts (report to
[OracleDesk-SmartContract](https://github.com/OracleDesk/OracleDesk-SmartContract)),
the backend (report to
[OracleDesk-Backend](https://github.com/OracleDesk/OracleDesk-Backend)), and
third-party dependencies unless this repo's use of them is what's
exploitable.

## How to verify what you're signing

Wallet prompts show 56-character addresses that are easy to misread, and any
`NEXT_PUBLIC_*` variable can redirect a build to a look-alike contract. The
app therefore shows, before every signature and in a banner whenever the
build is non-canonical:

- the **full contract address** in 4-character groups (compare the middle of
  the address, not just the ends — truncation is what vanity-address
  attackers grind for);
- a **three-word fingerprint** derived from the SHA-256 of the decoded
  address (first 33 bits → three words from a fixed 2048-word list). This is
  a **UX aid, not a cryptographic guarantee**: it makes comparison fast and
  cheap to do consistently, but it proves nothing on its own;
- the **source**: "Official deployment @\<commit\>" (the pinned manifest in
  `lib/stellar/generated/contract-manifest.ts`) or "Overridden by this
  build".

When the amount matters, cross-check the address against an independent
source such as [Stellar Expert](https://stellar.expert/explorer/testnet) or
the deployment recorded in the contracts repository. Official builds can be
made to fail at build time instead of warning (`ORACLEDESK_REQUIRE_CANONICAL=1`).

## Data we may send, and how to say no

Error reports and usage analytics are strictly opt-in and documented
field-by-field in [docs/privacy.md](docs/privacy.md), including what is
hashed (wallet addresses) and what is never sent (tokens, seeds, XDR,
signatures). The short version lives at `/privacy` in the app. Nothing is
sent without an explicit choice in Settings → Privacy (or the first-error
prompt), and Do Not Track / Global Privacy Control are always honoured as
"no".
