# Error fixtures

Serialized error shapes used by `errors.fixtures.test.ts`. Each file is one
case with the exact `describeError` expectation.

## Format

```json
{
  "id": "sim/market-core/market-closed",
  "source": "simulation | send | wallet | backend | sdk",
  "capturedWith": { "sdk": "16.3.1", "kit": "2.5.0", "wallet": "freighter" },
  "error": { "name": "Error", "message": "HostError: Error(Contract, #9)" },
  "context": { "contract": "marketCore" },
  "events": [{ "contract": "usdc", "code": 10 }],
  "errorResultCode": "txBadSeq",
  "expect": { "kind": "contract", "code": "MarketClosed", "contract": "marketCore" }
}
```

`events` are rebuilt as real `xdr.DiagnosticEvent` values by the test, so the
decoder is exercised against the RPC shape rather than a hand-written object.
`errorResultCode` is turned into an `xdr.TransactionResult` arm.

## Capture procedure

These cases encode the shapes the SDK, RPC and wallet kit throw
(`@stellar/stellar-sdk` 16.3.1, `@creit.tech/stellar-wallets-kit` 2.5.0).
To refresh them against a live testnet, run the failing call and paste the
caught value into a new file:

1. Simulation: build the call with `clients.ts`, keep `tx.simulation`, and
   serialize each event with `event.toXDR("base64")`. Keep the `error` string.
2. Send: submit a transaction with a stale sequence (`txBadSeq`) or an expired
   time bound (`txTooLate`) from a funded throwaway `Keypair.random()`, then
   serialize `sendTransactionResponse.errorResult` and `diagnosticEvents`.
3. Wallet: trigger reject, locked/no-signer and wrong-network in each kit
   module, then log
   `JSON.stringify(err, Object.getOwnPropertyNames(err))`. Keep only `name`,
   `message` and numeric `code`.
4. Backend: capture an `ApiError` from `lib/api/client.ts`.

Never commit a secret seed, a signature or a JWT. The fixture test fails if one
appears. Contract bindings regenerate the code tables; when a contract changes
an error code, update the fixture expectation deliberately.
