"use client";

import { useEffect, useMemo, useState } from "react";
import { useInfiniteTraces } from "@/lib/hooks/useTraces";
import { mergeTracePages } from "@/lib/hooks/trace-feed";
import type { ReasoningTrace } from "@/lib/api/traces";
import { matches, serverParams, type TraceFeedFilters } from "@/lib/traces/feed-filters";

/** Items the feed tries to show before it stops fetching on its own. */
export const TARGET_MATCHES = 20;
/** Pages fetched automatically per filter change or explicit "Load more". */
export const MAX_AUTO_PAGES = 5;

/**
 * The trace feed with client-side filters applied to each loaded page.
 * Pages are fetched only while fewer than `TARGET_MATCHES` items match, and only
 * `MAX_AUTO_PAGES` at a time. The UI then offers an explicit "Load more".
 */
export function useFilteredTraceFeed(filters: TraceFeedFilters, heldMarketIds: ReadonlySet<string> | null) {
  const query = useInfiniteTraces(serverParams(filters));
  const loaded = useMemo(() => mergeTracePages(query.data?.pages.map((page) => page.traces) ?? []), [query.data]);
  const visible: ReasoningTrace[] = useMemo(
    () => loaded.filter((trace) => matches(trace, filters, heldMarketIds)),
    [loaded, filters, heldMarketIds],
  );

  const filterKey = JSON.stringify(filters) + (heldMarketIds ? heldMarketIds.size : "none");
  const [budget, setBudget] = useState(MAX_AUTO_PAGES);
  useEffect(() => {
    setBudget(MAX_AUTO_PAGES);
  }, [filterKey]);

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    if (visible.length >= TARGET_MATCHES || !hasNextPage || isFetchingNextPage || budget <= 0) return;
    setBudget((remaining) => remaining - 1);
    void fetchNextPage();
  }, [visible.length, hasNextPage, isFetchingNextPage, budget, fetchNextPage]);

  return {
    /** Matching traces, in backend order. Items never reorder while the filter is unchanged. */
    visible,
    /** Traces loaded so far, before filtering. */
    scanned: loaded.length,
    /** Matching traces loaded so far. */
    matched: visible.length,
    /** True when the backend has no further pages. */
    exhausted: !hasNextPage,
    /** True when auto-fetching stopped with more pages available. */
    canLoadMore: Boolean(hasNextPage) && budget <= 0,
    /** Fetches one more page and grants a new auto-fetch budget. */
    loadMore: () => {
      setBudget(MAX_AUTO_PAGES);
      if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
    },
    isLoading: query.isLoading,
    isFetchingNextPage,
    hasNextPage: Boolean(hasNextPage),
    error: query.error,
  };
}
