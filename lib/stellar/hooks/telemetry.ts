import type { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import { recheckRpcAfterSimulation } from "@/lib/stellar/rpc-network-guard";
import { describeError, type ContractName } from "@/lib/stellar/errors";
import { DEBUG_ENABLED } from "@/lib/diagnostics/flags";
import { recordSimulation } from "@/lib/diagnostics/events";
import { currentRpcUrl, rpcPool } from "@/lib/stellar/clients";
import { isRateLimitError } from "@/lib/stellar/rpc-scheduler";

/**
 * Builds (and so simulates) a read against the pool's current endpoint, and
 * records latency, success and the simulated ledger into the RPC pool (and
 * the debug ring buffer when enabled). Recording never throws into the caller.
 */
export async function measured<Tx extends AssembledTransaction<unknown>>(method: string, build: () => Promise<Tx>, contract: ContractName | "usdc" = "marketCore"): Promise<Tx> {
  const url = currentRpcUrl();
  const t0 = Date.now();
  try {
    const tx = await build();
    await recheckRpcAfterSimulation();
    const sim = tx.simulation as { latestLedger?: number; error?: string } | undefined;
    try {
      rpcPool()?.record(url, { ms: Date.now() - t0, ok: true, latestLedger: sim?.latestLedger });
      if (DEBUG_ENABLED) recordSimulation(simRecord(contract, method, tx));
    } catch { /* telemetry only */ }
    return tx;
  } catch (err) {
    try {
      // 429s are already recorded by the rpcServer proxy with Retry-After; avoid double-counting.
      if (!isRateLimitError(err)) {
        rpcPool()?.record(url, { ms: Date.now() - t0, ok: false });
      }
      if (DEBUG_ENABLED) recordSimulation({ at: Date.now(), contract, method, error: describeError(err).message });
    } catch { /* telemetry only */ }
    throw err;
  }
}

export function simRecord(contract: ContractName | "usdc", method: string, tx: AssembledTransaction<unknown>) {
  const sim = tx.simulation as
    | { latestLedger?: number; minResourceFee?: string; error?: string; transactionData?: { build?: () => { resources(): { footprint(): { readOnly(): unknown[]; readWrite(): unknown[] } } } } }
    | undefined;
  let readEntries: number | undefined;
  let writeEntries: number | undefined;
  try {
    const fp = sim?.transactionData?.build?.().resources().footprint();
    readEntries = fp?.readOnly().length;
    writeEntries = fp?.readWrite().length;
  } catch { /* shape differs between success/restore/error simulations */ }
  return { at: Date.now(), contract, method, latestLedger: sim?.latestLedger, readEntries, writeEntries, minResourceFee: sim?.minResourceFee, error: sim?.error };
}
