import { z } from "zod";
import { apiClient, apiPath, ApiError, type ApiRequestOptions } from "./client";
import type { PaginationMeta } from "./markets";
import {
  isDriftAction,
  isDriftClass,
  type DriftAction,
  type DriftClass,
  type DriftFinding,
} from "@/lib/admin/drift";

export type ReconcileDriftClass = DriftClass | string;
export type ReconcileDriftAction = DriftAction | string;

export interface ReconcileRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  scanned: number;
  repaired: number;
  reported: number;
  deferred: number;
  rpcCalls: number;
  error: string | null;
}

export type MarketDriftReport = DriftFinding;

export interface ReconcileRunDetail {
  run: ReconcileRun;
  findings: MarketDriftReport[];
  meta?: PaginationMeta;
}

export interface TriggerReconcileParams {
  dryRun?: boolean;
  maxMarkets?: number;
}

export interface TriggerReconcileResult {
  runId: string;
  message: string;
}

function normalizeDriftClass(value: string): ReconcileDriftClass {
  if (isDriftClass(value)) return value;
  if (process.env.NODE_ENV !== "production") {
    console.warn(`Unknown reconciliation driftClass from backend: ${value}`);
  }
  return value;
}

function normalizeDriftAction(value: string): ReconcileDriftAction {
  if (isDriftAction(value)) return value;
  if (process.env.NODE_ENV !== "production") {
    console.warn(`Unknown reconciliation action from backend: ${value}`);
  }
  return value;
}

const driftClassSchema = z.string().transform(normalizeDriftClass);
const driftActionSchema = z.string().transform(normalizeDriftAction);

const nullableString = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((value) => value ?? null);

const ReconcileRunSchema = z
  .object({
    id: z.string(),
    startedAt: z.string(),
    finishedAt: nullableString,
    scanned: z.number(),
    repaired: z.number(),
    reported: z.number(),
    deferred: z.number(),
    rpcCalls: z.number(),
    error: nullableString,
  })
  .passthrough();

const onChainIdSchema = z
  .union([z.string(), z.number(), z.bigint()])
  .transform((value) => String(value));

const MarketDriftReportSchema = z
  .object({
    id: z.string().optional(),
    runId: z.string(),
    marketId: z.string(),
    onChainMarketId: onChainIdSchema,
    driftClass: driftClassSchema,
    dbValue: z.unknown(),
    chainValue: z.unknown(),
    action: driftActionSchema,
    observedLedger: z.number(),
    createdAt: z.string().optional(),
  })
  .passthrough();

const ReconcileRunDetailSchema = z.object({
  run: ReconcileRunSchema,
  findings: z.array(MarketDriftReportSchema),
});

const TriggerReconcileSchema = z.object({
  dryRun: z.boolean().optional(),
  maxMarkets: z.number().int().min(1).max(5_000).optional(),
});

const TriggerResultSchema = z.object({
  runId: z.string(),
  message: z.string(),
});

export async function listReconcileRuns(
  limit = 20,
  options: ApiRequestOptions = {},
): Promise<ReconcileRun[]> {
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
  const { data } = await apiClient.get<ReconcileRun[]>(
    apiPath`/admin/reconciliation/runs`,
    { limit: safeLimit },
    { ...options, schema: z.array(ReconcileRunSchema) },
  );
  return data;
}

export async function getReconcileRun(
  id: string,
  page = 1,
  limit = 200,
  options: ApiRequestOptions = {},
): Promise<ReconcileRunDetail> {
  const safePage = Math.max(1, Math.floor(page));
  const safeLimit = Math.min(200, Math.max(1, Math.floor(limit)));
  const { data, meta } = await apiClient.get<{ run: ReconcileRun; findings: MarketDriftReport[] }>(
    apiPath`/admin/reconciliation/runs/${id}`,
    { page: safePage, limit: safeLimit },
    { ...options, schema: ReconcileRunDetailSchema },
  );
  return { ...data, meta: meta as PaginationMeta | undefined };
}

export async function triggerReconcileRun(
  params: TriggerReconcileParams,
  options: ApiRequestOptions = {},
): Promise<TriggerReconcileResult> {
  const parsed = TriggerReconcileSchema.safeParse(params);
  if (!parsed.success) {
    throw new ApiError({ code: "VALIDATION_ERROR", message: "Invalid reconciliation request" }, 400);
  }
  const { data } = await apiClient.post<TriggerReconcileResult>(
    apiPath`/admin/reconciliation/run`,
    parsed.data,
    undefined,
    { ...options, schema: TriggerResultSchema },
  );
  return data;
}
