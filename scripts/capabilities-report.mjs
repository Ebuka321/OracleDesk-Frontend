#!/usr/bin/env node
/**
 * Operator CLI: prints a capability table for a deployed Soroban contract.
 * Usage: node scripts/capabilities-report.mjs --contract <C...> --rpc <url> [--key marketCore|treasury|resolver|reasoningRegistry]
 */
import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import { Spec } from "@stellar/stellar-sdk/contract";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(flag) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

const contractId = arg("--contract");
const rpcUrl = arg("--rpc") || "https://soroban-testnet.stellar.org";
const keyFilter = arg("--key");

if (!contractId) {
  console.error("Usage: node scripts/capabilities-report.mjs --contract <C...> [--rpc <url>] [--key <contractKey>]");
  process.exit(2);
}

const capSpecsPath = join(ROOT, "lib", "stellar", "generated", "capability-specs.json");
const capSpecs = JSON.parse(readFileSync(capSpecsPath, "utf8"));

const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
const instanceKey = xdr.LedgerKey.contractData(
  new xdr.LedgerKeyContractData({
    contract: new Address(contractId).toScAddress(),
    key: xdr.ScVal.scvLedgerKeyContractInstance(),
    durability: xdr.ContractDataDurability.persistent(),
  }),
);

const instanceRes = await server.getLedgerEntries(instanceKey);
if (!instanceRes.entries.length) {
  console.error(`Contract instance not found: ${contractId}`);
  process.exit(1);
}
const wasmHash = instanceRes.entries[0].val.contractData().val().instance().executable().wasmHash();
const codeKey = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: wasmHash }));
const codeRes = await server.getLedgerEntries(codeKey);
if (!codeRes.entries.length) {
  console.error(`Contract code not found for wasmHash ${wasmHash.toString("hex")}`);
  process.exit(1);
}
const wasmBytes = codeRes.entries[0].val.contractCode().code();
const onChainSpec = Spec.fromWasm(Buffer.from(wasmBytes));
const onChainFns = new Set(
  onChainSpec.entries
    .filter((e) => e.arm() === "functionV0")
    .map((e) => e.value().name().toString()),
);

const CAPABILITIES = {
  "marketCore.core": { contract: "marketCore", fns: ["buy","sell","redeem","get_market","get_position","quote_buy","quote_sell","get_config","market_count","claim_pool_remainder"] },
  "marketCore.buyV2": { contract: "marketCore", fns: ["buy_v2","sell_v2"] },
  "marketCore.sellShares": { contract: "marketCore", fns: ["sell_shares","quote_sell_shares"] },
  "marketCore.splitMerge": { contract: "marketCore", fns: ["split","merge"] },
  "marketCore.breaker": { contract: "marketCore", fns: ["breaker_state","would_trip"] },
  "registry.core": { contract: "reasoningRegistry", fns: ["get_trace","trace_count"] },
  "registry.chainedTraces": { contract: "reasoningRegistry", fns: ["publish_chained_trace","get_trace_link","agent_chain_head"] },
  "registry.flags": { contract: "reasoningRegistry", fns: ["trace_flags","get_trace_flag"] },
  "resolver.disputes": { contract: "resolver", fns: ["dispute","settle_dispute","expire_dispute","claim_dispute_bond"] },
  "treasury.core": { contract: "treasury", fns: ["get_config","daily_usage","available_capital"] },
  "treasury.vault": { contract: "treasury", fns: ["nav","shares_of","request_withdraw","claim_withdraw"] },
};

console.log(`Contract: ${contractId} (wasm ${wasmHash.toString("hex").slice(0, 12)}…)`);
console.log("Capability                  | Status      | Missing / Note");
console.log("----------------------------+-------------+------------------------------");
for (const [cap, def] of Object.entries(CAPABILITIES)) {
  if (keyFilter && def.contract !== keyFilter) continue;
  const bundledFns = new Set((capSpecs[def.contract] ?? []).map((b64) => {
    const entry = xdr.ScSpecEntry.fromXDR(b64, "base64");
    return entry.arm() === "functionV0" ? entry.value().name().toString() : "";
  }));
  const missingOnChain = def.fns.filter((f) => !onChainFns.has(f));
  const missingInBundle = def.fns.filter((f) => !bundledFns.has(f));
  const status = missingOnChain.length === 0 && missingInBundle.length === 0 ? "available" : "unavailable";
  const note = missingOnChain.length ? `missing on-chain: ${missingOnChain.join(", ")}` : missingInBundle.length ? "not in bundled bindings" : "ok";
  console.log(`${cap.padEnd(27)} | ${status.padEnd(11)} | ${note}`);
}
