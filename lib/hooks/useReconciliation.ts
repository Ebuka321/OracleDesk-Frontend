"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getReconcileRun,
  listReconcileRuns,
  triggerReconcileRun,
  type TriggerReconcileParams,
  type TriggerReconcileResult,
} from "@/lib/api/admin";
import { getMarket } from "@/lib/api/markets";
import { recheckFindings, type RecheckResult } from "@/lib/admin/recheck";
import type { DriftFinding } from "@/lib/admin/drift";
import { userKeys } from "@/lib/query/keys";
import { useUserScope } from "@/lib/query/scope";
import { useScopedMutation } from "@/lib/query/useScopedMutation";
import { marketBatcher } from "@/lib/hooks/useStellar";
import { ledgerClock } from "@/lib/stellar/ledger-clock";

const MAX_RUN_POLL_MS = 30 * 60_000;

function pollInterval(startedAt: readonly string[]): number | false {
  const starts = startedAt.map((value) => Date.parse(value)).filter((value) => Number.isFinite(value));
  if (starts.length === 0) return false;
  const age = Date.now() - Math.min(...starts);
  if (age > MAX_RUN_POLL_MS) return false;
  return Math.min(30_000, 5_000 * (1 + Math.floor(age / 60_000)));
}

export function useReconcileRuns(limit = 20) {
  const scope = useUserScope();
  return useQuery({
    queryKey: userKeys.reconcileRuns(scope),
    queryFn: ({ signal }) => listReconcileRuns(limit, { expectScope: scope, signal }),
    enabled: Boolean(scope.wallet),
    refetchInterval: (query) => {
      const runs = query.state.data;
      if (!runs?.some((run) => !run.finishedAt)) return false;
      return pollInterval(runs.filter((run) => !run.finishedAt).map((run) => run.startedAt));
    },
  });
}

export function useReconcileRun(runId: string | null) {
  const scope = useUserScope();
  return useInfiniteQuery({
    queryKey: userKeys.reconcileRun(scope, runId ?? ""),
    queryFn: ({ pageParam, signal }) =>
      getReconcileRun(runId ?? "", pageParam as number, 200, { expectScope: scope, signal }),
    initialPageParam: 1,
    getNextPageParam: (lastPage) =>
      lastPage.meta && lastPage.meta.page < lastPage.meta.totalPages
        ? lastPage.meta.page + 1
        : undefined,
    enabled: Boolean(scope.wallet) && Boolean(runId),
    refetchInterval: (query) => {
      const run = query.state.data?.pages[0]?.run;
      if (!run || run.finishedAt) return false;
      return pollInterval([run.startedAt]);
    },
  });
}

export function useTriggerReconcile() {
  const queryClient = useQueryClient();
  const inFlight = useRef(false);
  const [runId, setRunId] = useState<string | null>(null);

  const mutation = useScopedMutation<TriggerReconcileResult, TriggerReconcileParams>(
    async (params, options) => {
      if (inFlight.current) throw new Error("A reconciliation run is already starting.");
      inFlight.current = true;
      try {
        return await triggerReconcileRun(params, options);
      } finally {
        inFlight.current = false;
      }
    },
    async (data, _variables, scope) => {
      setRunId(data.runId);
      await queryClient.invalidateQueries({ queryKey: userKeys.reconcileRuns(scope) });
    },
  );

  const clearRunId = useCallback(() => setRunId(null), []);
  return { ...mutation, runId, clearRunId };
}

export function useRecheck(findings: readonly DriftFinding[]) {
  const scope = useUserScope();
  const ledger = ledgerClock.now();
  const ledgerBucket = Math.floor((ledger ?? 0) / 10);

  const groups = useMemo(() => {
    const map = new Map<string, DriftFinding[]>();
    findings.forEach((finding) => {
      const id = String(finding.onChainMarketId ?? "invalid");
      const group = map.get(id) ?? [];
      group.push(finding);
      map.set(id, group);
    });
    return [...map.entries()].map(([onChainMarketId, items]) => ({ onChainMarketId, items }));
  }, [findings]);

  const queries = useQueries({
    queries: groups.map(({ onChainMarketId, items }) => ({
      queryKey: ["stellar", "recheck", onChainMarketId, ledgerBucket] as const,
      queryFn: async () =>
        recheckFindings(items, {
          batcher: marketBatcher,
          backendMarket: (id: string) => getMarket(id),
          ledgerTime: async () => (ledgerClock.now() ?? Date.now() / 1_000) * 1_000,
        }),
      enabled: Boolean(scope.wallet),
      staleTime: 30_000,
      retry: false,
    })),
  });

  const data = useMemo(() => {
    const merged = new Map<string, RecheckResult>();
    for (const query of queries) {
      if (!query.data) continue;
      for (const [key, result] of query.data) merged.set(key, result);
    }
    return merged;
  }, [queries]);

  const refetch = useCallback(async () => {
    await Promise.all(queries.map((query) => query.refetch()));
  }, [queries]);

  return {
    data,
    refetch,
    isFetching: queries.some((query) => query.isFetching),
  };
}
