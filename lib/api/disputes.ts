import { z } from "zod";
import { apiClient, apiPath, type ApiRequestOptions } from "./client";
import { DisputeReviewSchema, GuardianTxSchema } from "./schemas";

const DisputeListSchema = z.array(DisputeReviewSchema);

/** Guardian dispute queue (backend dispute monitor). All endpoints require `disputes.manage`. */
export async function listDisputes(status: "open" | "all" = "open", options?: ApiRequestOptions) {
  return apiClient.get("/admin/disputes", { status }, { ...options, schema: DisputeListSchema });
}

export async function ackDispute(id: string, options?: ApiRequestOptions) {
  const { data } = await apiClient.post(apiPath`/admin/disputes/${id}/ack`, undefined, undefined, { ...options, schema: DisputeReviewSchema });
  return data;
}

/** Fetch the unsigned guardian transaction. Always run verifyGuardianTx before signing it. */
export async function getGuardianTx(id: string, kind: "cancel" | "void", options?: ApiRequestOptions) {
  const path = kind === "cancel" ? apiPath`/admin/disputes/${id}/cancel-tx` : apiPath`/admin/disputes/${id}/void-tx`;
  const { data } = await apiClient.post(path, undefined, undefined, { ...options, schema: GuardianTxSchema });
  return data;
}
