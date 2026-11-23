import { apiClient } from "./client";
import { apiPath } from "@/lib/validation/api-path";
import type { TreasuryOpKind } from "@/lib/stellar/treasury-decoder";

export interface PreflightCheck {
  name: string;
  passed: boolean;
  message?: string;
}

export interface TreasurySignerInfo {
  key: string;
  weight: number;
}

export interface TreasuryOperationRecord {
  id: string;
  kind: TreasuryOpKind;
  xdr: string;
  hash: string;
  networkPassphrase: string;
  sourceAccount: string;
  humanSummary: string; // UNTRUSTED! Always display labelled as unverified
  validUntil: number; // Unix seconds
  expiresAt: number; // Wall-clock timestamp ms
  fee: string;
  status: "PREPARED" | "SIGNING" | "READY" | "SUBMITTED" | "SUCCESS" | "FAILED" | "EXPIRED" | "CANCELLED";
  signatures: { signer: string; weight: number; hint: string }[];
  requiredSigners: TreasurySignerInfo[];
  requiredThreshold: number; // HIGH threshold requirement (authority)
  collectedWeight: number;
  preflightChecks?: PreflightCheck[];
  txHash?: string | null;
  createdAt: number;
}

export interface PrepareOperationParams {
  kind: TreasuryOpKind;
  params: Record<string, unknown>;
  force?: boolean;
}

/**
 * Calculates collected weight strictly matching backend requiredSigners.
 */
export function calculateCollectedWeight(
  signatures: { signer: string; weight?: number; hint?: string }[],
  requiredSigners: TreasurySignerInfo[]
): number {
  const signerWeightMap = new Map(requiredSigners.map((s) => [s.key, s.weight]));
  const counted = new Set<string>();
  let total = 0;

  for (const sig of signatures) {
    if (signerWeightMap.has(sig.signer) && !counted.has(sig.signer)) {
      counted.add(sig.signer);
      total += signerWeightMap.get(sig.signer) ?? 0;
    }
  }
  return total;
}

/**
 * Checks whether an operation is ready for submission:
 * Collected weight must meet the backend's requiredThreshold (HIGH).
 */
export function isOperationReady(op: TreasuryOperationRecord): boolean {
  const collected = calculateCollectedWeight(op.signatures, op.requiredSigners);
  return collected >= op.requiredThreshold;
}

export async function prepareTreasuryOperation(
  data: PrepareOperationParams
): Promise<TreasuryOperationRecord> {
  const response = await apiClient.post<TreasuryOperationRecord>(
    apiPath`/admin/treasury/operations/prepare`,
    data
  );
  return response.data;
}

export async function listTreasuryOperations(): Promise<TreasuryOperationRecord[]> {
  const response = await apiClient.get<TreasuryOperationRecord[]>(
    apiPath`/admin/treasury/operations`
  );
  return response.data ?? [];
}

export async function getTreasuryOperation(id: string): Promise<TreasuryOperationRecord> {
  const response = await apiClient.get<TreasuryOperationRecord>(
    apiPath`/admin/treasury/operations/${id}`
  );
  return response.data;
}

export async function uploadTreasurySignature(
  id: string,
  signedXdr: string
): Promise<TreasuryOperationRecord> {
  const response = await apiClient.post<TreasuryOperationRecord>(
    apiPath`/admin/treasury/operations/${id}/signatures`,
    { signedXdr }
  );
  return response.data;
}

export async function submitTreasuryOperation(
  id: string
): Promise<{ txHash: string; operation: TreasuryOperationRecord }> {
  const response = await apiClient.post<{ txHash: string; operation: TreasuryOperationRecord }>(
    apiPath`/admin/treasury/operations/${id}/submit`
  );
  return response.data;
}

export async function cancelTreasuryOperation(
  id: string
): Promise<TreasuryOperationRecord> {
  const response = await apiClient.post<TreasuryOperationRecord>(
    apiPath`/admin/treasury/operations/${id}/cancel`
  );
  return response.data;
}
