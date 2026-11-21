"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { marketCore, resolver } from "@/lib/stellar/clients";
import { enumerateOnChainMarketTraces } from "@/lib/stellar/market-audit";
import {
  buildLifecycle,
  fetchMarketLifecycleEvents,
  type LifecycleEntry,
  type TimelineEvent,
} from "@/lib/stellar/market-lifecycle";
import {
  lifecycleCacheKey,
  readLifecycleCache,
  writeLifecycleCache,
} from "@/lib/stellar/price-history";
import { read } from "@/lib/stellar/typed-call";
import { useRealtimeBatch } from "@/lib/realtime/RealtimeProvider";

export function useMarketLifecycle(onChainMarketId: bigint | string | null | undefined) {
  const idStr = onChainMarketId !== null && onChainMarketId !== undefined ? String(onChainMarketId) : "";
  const queryClient = useQueryClient();
  const [olderPages, setOlderPages] = useState(0);

  // Invalidate on TRADE_EXECUTED socket events for this market
  useRealtimeBatch((batch) => {
    if (!idStr) return;
    if (
      batch.some(
        (ev) => ev.type === "TRADE_EXECUTED" && ev.payload.onChainMarketId === idStr,
      )
    ) {
      void queryClient.invalidateQueries({ queryKey: ["stellar", "lifecycle", idStr] });
    }
  });

  const query = useQuery({
    queryKey: ["stellar", "lifecycle", idStr, olderPages] as const,
    enabled: Boolean(idStr),
    queryFn: async ({ signal }): Promise<{ entries: LifecycleEntry[]; partial: boolean }> => {
      const marketId = BigInt(idStr);
      const key = lifecycleCacheKey(idStr);
      const cached = await readLifecycleCache(key);

      const [marketTx, stateTx, traces] = await Promise.all([
        marketCore().get_market({ market_id: marketId }),
        resolver().state({ market_id: marketId }),
        enumerateOnChainMarketTraces(marketId),
      ]);
      const market = read(marketTx);
      const resolverState = read(stateTx, "resolver").tag;

      const fromLedger = cached && olderPages === 0 ? cached.toLedger + 1 : undefined;
      const fresh = await fetchMarketLifecycleEvents(marketId, {
        fromLedger,
        signal,
        market: { lp_claimed: market.lp_claimed, creator: market.creator },
      });

      const cachedEvents = (cached?.events ?? []) as TimelineEvent[];
      const mergedMap = new Map<string, TimelineEvent>();
      for (const ev of cachedEvents) mergedMap.set(ev.id, ev);
      for (const ev of fresh.events) mergedMap.set(ev.id, ev);
      const allEvents = [...mergedMap.values()];

      await writeLifecycleCache(key, {
        v: 1,
        events: allEvents,
        toLedger: fresh.window.latestLedger,
        cursors: {},
        coverage: {
          fromLedger: fresh.window.oldestLedger,
          toLedger: fresh.window.latestLedger,
          complete: !fresh.partial,
        },
      });

      const entries = buildLifecycle({
        events: allEvents,
        market,
        resolverState,
        traces,
        window: fresh.window,
        partial: fresh.partial,
      });

      return { entries, partial: fresh.partial };
    },
    staleTime: 30_000,
  });

  return {
    ...query,
    loadOlder: () => setOlderPages((p) => p + 1),
  };
}
