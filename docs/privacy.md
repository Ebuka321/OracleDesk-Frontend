# Privacy: what this app collects

OracleDesk is usable with **no** error reporting and **no** analytics. Both
are opt-in, stored as choices in your browser only, and never enabled
implicitly. This document is the field-by-field inventory; it doubles as the
changelog (entries appended when an event or field changes).

## Error reports (`NEXT_PUBLIC_ERROR_REPORTING_DSN`)

Off unless the deployment sets a DSN **and** you consent. Consent lives in
`localStorage.oracledesk_error_reporting` (`granted` / `denied`), defaults to
**denied**, and Do Not Track (`navigator.doNotTrack === "1"`) and Global
Privacy Control are always treated as denied regardless of the stored value.

### Fields collected

| Field | Content |
| --- | --- |
| `id`, `timestamp` | Client-generated reference id (8 characters, shown in the UI) and ISO time |
| `release` | `NEXT_PUBLIC_BUILD_SHA` (commit the bundle was built from), else `dev` |
| `environment` | Network label (`Stellar Testnet` / `Stellar`) |
| `route` | Pathname only — never query strings or fragments |
| `level` | `error` / `warning` / `info` |
| `kind`, `code` | From `UserFacingError`: classification (`contract`, `network`, `rejected`, …) and contract error name (e.g. `SlippageExceeded`) |
| `apiCode`, `httpStatus` | Backend error envelope code and HTTP status |
| `message`, `stack` | Redacted error message and stack frames (browser-extension frames dropped) |
| `walletModule` | Wallet module id when known (e.g. `freighter`), else omitted |
| `breadcrumbs` | Route changes and mutation start/success/rejection markers — no amounts, no addresses |
| `tags` | `feature`, `error_name`, `wallet_module`, `contained_secret` (flag only) |
| `extra` | Explicitly attached context only; currently `txHash` on the paid-but-not-activated premium path |

### What is redacted before sending

Applied field-by-field and then again to the serialized event — if a JWT or
secret-seed pattern survives the second pass, the **whole event is dropped**:

- JWTs → `[jwt]`; Stellar secret seeds → `[secret]` (+ `contained_secret` tag).
- Public addresses (G/C/M StrKeys) → `G:1a2b3c4d`, the first 8 hex of
  HMAC-SHA256 with a random per-install salt (`localStorage.oracledesk_redact_salt`).
  The same address correlates within one install; nothing links across installs.
  Public contract ids from `CONTRACTS` are allowlisted and stay intact.
- Base64 runs over 80 characters (XDR, signatures) → `[xdr:<length>]`.
- URLs keep scheme + host + path; query strings and fragments are dropped.
- 64-hex strings stay (public transaction hashes) unless adjacent to
  `secret`/`priv`/`seed` wording.
- Object walk: depth ≤ 5, keys matching
  `token|authorization|signature|signed|secret|xdr|envelope|password` dropped,
  strings capped at 1 kB, arrays at 20 items, cycles broken.

Never collected: your wallet address in clear text, JWTs, secret seeds,
signatures, XDR, Authorization headers, exact amounts, form contents.

### Limits

10 events per minute; identical level+kind+code+message within 60 seconds is
sent once. Re-entrancy guard prevents error loops. Reporting failing never
breaks the app (send errors are swallowed).

### Opt-out

Settings → Privacy → turn off "Send anonymous error reports"; or clear site
data; or simply never answer the one-time prompt (it defaults to no).

## Analytics (`NEXT_PUBLIC_ANALYTICS_PROVIDER`)

Off unless the deployment sets a provider (`posthog`, `plausible` or `http`)
**and** you consent. Consent lives in `localStorage.oracledesk_analytics_consent`
(`granted` / `denied`), defaults to **no**, and Do Not Track / Global Privacy
Control are always treated as denied regardless of the stored value — the
banner never even appears when either signal is on. Before consent **no event
is sent and no provider script is loaded**; declining drops events outright
(they are never queued and replayed). With no provider configured the whole
layer is a no-op and the provider modules are not even bundled.

Every event additionally carries:

| Field | Content |
| --- | --- |
| `schema` | Event-schema version (`ANALYTICS_SCHEMA_VERSION`); bumped whenever any event or property changes |
| `route` | Pathname only — never query strings or fragments |
| `network` | Network label (`Stellar Testnet` / `Stellar`) |

### Events

| Event | Properties | Fired when |
| --- | --- | --- |
| `wallet_modal_opened` | — | The connect dialog is opened |
| `wallet_connected` | `walletModule` (fixed list, else `other`), `fresh` (user-initiated vs silent restore) | A wallet becomes connected |
| `wallet_connect_failed` | `kind` (error classification) | Connect fails before any wallet is connected |
| `wallet_network_checked` | `status` (`match` / `mismatch` / `unknown`) | The wallet's network status changes while connected |
| `signin_started` / `signin_completed` | `outcome` on completion | SEP-10 sign-in begins / ends |
| `quote_requested` | `side` (`Yes` / `No`), `amount` (bucket) | A `quote_buy` query key changes — never on background refetches |
| `quote_failed` | `kind`, `code?` (contract error name) | That quote fails |
| `trade_submitted` | `action` (`buy` / `sell` / `redeem`), `side?`, `amount?` (bucket), `slippageBps?` (only 50 / 100 / 300) | A trade mutation starts |
| `trade_wallet_prompted` | `action` | Immediately before the wallet opens for a signature |
| `trade_completed` | `action`, `outcome`, `code?`, `durationBucket` | A trade settles (success or classified failure) |
| `premium_payment_started` / `premium_payment_completed` | `outcome`, `stage` (`transfer` = failed before USDC left, `unlock` = paid but not activated) | Premium purchase begins / settles |
| `copy_trade_completed` | `outcome`, `confirmRecorded` | Exactly once per copy trade: on failure, or when the backend confirms the recording |

`outcome` is `success` or the classified error kind (`rejected`, `contract`,
`network`, …) — the same vocabulary as error reports, never free text.

### Buckets (exact values are never sent)

- **Amounts** (bigint comparisons only): `<1`, `1-10`, `10-100`, `100-1k`, `>1k` USDC.
- **Durations**: `<5s`, `5-15s`, `15-60s`, `>60s`.

### Runtime guard

Whatever a call site passes, an event is **dropped entirely** if any string
property looks like an identifier: Stellar StrKey address, JWT, 64-hex
string, or a run of 8+ digits (which would leak an exact amount). This is
defence in depth on top of the typed catalog — a future bug cannot exfiltrate
an address through analytics.

### What is never collected

Wallet addresses, transaction hashes, exact amounts, market/trace ids, JWTs,
IP handling (disabled in the PostHog config), session recording, autocapture
and pageview capture (all disabled), and anything at all before you press
"Allow".

### Retention

The client sends events and stores nothing itself. Retention is whatever the
operator's configured provider applies (e.g. PostHog default 12 months,
configurable server-side); no identifier is generated to link you across
visits or installs.

### CSP origins

Allow only the configured host: `NEXT_PUBLIC_ANALYTICS_HOST` (PostHog serves
`/static/array.js`, Plausible serves `/js/script.js`, `http` is a plain POST
endpoint with no script). Nothing else needs to be added to `script-src`.

### Opt-out

Settings → Privacy → turn off "Send anonymous usage analytics"; or clear site
data; or never answer the banner (it defaults to no). Withdrawing also
resets the loaded provider.

## Changelog

- 2026-11-19: initial analytics inventory: 14 consent-gated funnel events
  with bucketed amounts/durations and a runtime identifier guard (issue #125).
- 2026-11-18: initial error-reporting inventory (issues #123).
