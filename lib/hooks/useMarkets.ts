"use client";

import { useEffect, useRef } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useUserScope } from "@/lib/query/scope";
import { userKeys, publicKeys } from "@/lib/query/keys";
import { useScopedMutation } from "@/lib/query/useScopedMutation";
import { fetchTrackedJob, isSessionError, nextPollInterval, shouldRetryStatus, statusRetryDelay, toJobPatch } from "./generation-status";
import { saveJob } from "@/lib/admin/job-store";
import {
  getMarket,
  getMarketGenerationStatus,
  listMarkets,
  triggerMarketGeneration,
  type ListMarketsParams,
} from "@/lib/api/markets";
import { nextPageParam } from "@/lib/ui/virtual-math";
export function useMarkets(params: ListMarketsParams = {}) {
  return useQuery({
    queryKey: publicKeys.markets(params),
    queryFn: () => listMarkets(params),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
}

export function useInfiniteMarkets(params: Omit<ListMarketsParams, "page"> = {}) {
  return useInfiniteQuery({
    queryKey: ["markets", "infinite", params],
    queryFn: ({ pageParam }) => listMarkets({ ...params, page: pageParam, limit: params.limit ?? 50 }),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => nextPageParam(lastPage.meta),
    staleTime: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function useMarket(id: string | undefined) {
  return useQuery({
    queryKey: publicKeys.market(id),
    queryFn: () => getMarket(id!),
    enabled: Boolean(id),
  });
}

/** Starts one market-maker run. The agent ignores inputs, so none are sent. */
export function useGenerateMarket() {
  return useScopedMutation(({ idempotencyKey }: { idempotencyKey: string }, options) => triggerMarketGeneration({}, idempotencyKey, options));
}

/**
 * Polls one generation job until it is COMPLETED, FAILED, UNKNOWN or gone
 * (404), saving every answer to the admin's job store. Polling pauses on a
 * session error until the caller signs in again and refetches.
 */
export function useMarketGenerationStatus(address: string | null | undefined, jobId: string, enabled: boolean) {
  const scope = useUserScope();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: userKeys.marketGeneration(scope, jobId),
    queryFn: ({ signal }) => fetchTrackedJob(jobId, (id) => getMarketGenerationStatus(id, { expectScope: scope, signal })),
    enabled: enabled && Boolean(address) && address === scope.wallet,
    staleTime: 0,
    retry: shouldRetryStatus,
    retryDelay: statusRetryDelay,
    refetchInterval: (q) => (q.state.error && !shouldRetryStatus(0, q.state.error) ? false : nextPollInterval(q.state.data)),
  });

  const { data, dataUpdatedAt } = query;
  const lastStatus = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!data || !address) return;
    saveJob(address, toJobPatch(data, dataUpdatedAt));
    if (data.status === "COMPLETED" && lastStatus.current !== "COMPLETED") {
      queryClient.invalidateQueries({ queryKey: ["markets"] });
      queryClient.invalidateQueries({ queryKey: ["platform-stats"] });
    }
    lastStatus.current = data.status;
  }, [data, dataUpdatedAt, address, queryClient]);

  return { query, sessionExpired: isSessionError(query.error) };
}

import {
  verifyMarketQuestion,
  formatHashHex,
  getCachedQuestionCheck,
  type QuestionIntegrityCheck,
} from "@/lib/stellar/market-question";

export function useMarketQuestionIntegrity(params: {
  marketId?: string | null;
  onChainMarketId?: string | null;
  displayedQuestion: string;
  metaUri?: string | null;
  questionHash?: Buffer | Uint8Array | string | null;
  hasChainRead?: boolean;
  chainMarket?: {
    close_time?: bigint | number;
    category?: unknown;
    resolution_hash?: Buffer | Uint8Array | string | null;
  } | null;
}) {
  const committedHash = formatHashHex(params.questionHash);
  const key = committedHash || `${params.marketId || params.onChainMarketId || "unknown"}:no-hash`;

  return useQuery({
    queryKey: ["market-question-integrity", key, params.displayedQuestion, params.hasChainRead],
    queryFn: async (): Promise<QuestionIntegrityCheck> => {
      if (committedHash) {
        const cached = getCachedQuestionCheck(committedHash);
        if (cached) return cached;
      }
      return verifyMarketQuestion({
        displayedQuestion: params.displayedQuestion,
        metaUri: params.metaUri,
        questionHash: params.questionHash,
        hasChainRead: params.hasChainRead,
        chainMarket: params.chainMarket,
      });
    },
    staleTime: Infinity,
    enabled: Boolean(params.displayedQuestion),
  });
}

