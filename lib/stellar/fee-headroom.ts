/** Learns a per-method resource-fee buffer ratio from a confirmed tx's simulated vs. actually-charged resource fee. */
export function computeFeeHeadroomRatio(simulatedResourceFee: bigint, actualChargedFee: bigint): number {
  if (simulatedResourceFee <= 0n) return 0;
  const diff = actualChargedFee - simulatedResourceFee;
  return Number(diff) / Number(simulatedResourceFee);
}
