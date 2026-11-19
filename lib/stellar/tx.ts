/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AssembledTransaction } from "@stellar/stellar-sdk/contract";
import type { ContractName } from "./errors";
import { read, submit, type Unwrapped, type TxValue } from "./typed-call";

export { read, submit };
export const simulated = read;

/**
 * Simulates, signs, and sends an AssembledTransaction with contract error mapping.
 */
export async function send<Tx extends AssembledTransaction<any>>(
  tx: Tx,
  contract: ContractName = "marketCore",
): Promise<{ value: Unwrapped<TxValue<Tx>>; txHash: string | null; ledger: number | null }> {
  return submit(tx, contract);
}
