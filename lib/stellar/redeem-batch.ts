import type { Redeemable } from "./redeem-all";

/**
 * Batch planner for market-core `redeem_many` (issue #271). Pure apart from
 * the injected simulator. The pinned bindings do not expose `redeem_many` yet,
 * so `useRedeemAll` keeps the per-market path until they are regenerated.
 */

/** Contract cap: `MAX_BATCH` in market-core. */
export const MAX_REDEEM_BATCH = 46;

export interface PlannedBatch { ids: bigint[]; expectedTotal: bigint }
export interface BatchPlan { batches: PlannedBatch[]; singles: bigint[] }

/** `resource`: the batch exceeds Soroban limits; `failed`: some id in it cannot be batched. */
export type SimOutcome = { ok: true } | { ok: false; reason: "resource" | "failed" };

export async function planBatches(
  items: Redeemable[],
  simulate: (ids: bigint[]) => Promise<SimOutcome>,
  opts: { max?: number } = {},
): Promise<BatchPlan> {
  const max = Math.min(opts.max ?? MAX_REDEEM_BATCH, MAX_REDEEM_BATCH);
  const byId = new Map<bigint, Redeemable>();
  for (const item of items) byId.set(item.marketId, item);
  const sorted = [...byId.values()].sort((a, b) => (a.marketId < b.marketId ? -1 : a.marketId > b.marketId ? 1 : 0));

  // Archived entries fail at footprint time; they go to the single-market path.
  const singles = sorted.filter((i) => i.archived).map((i) => i.marketId);
  let queue = sorted.filter((i) => !i.archived);
  const batches: PlannedBatch[] = [];
  let size = max;

  while (queue.length) {
    const chunk = queue.slice(0, Math.min(size, queue.length));
    const outcome = await simulate(chunk.map((i) => i.marketId));
    if (outcome.ok) {
      batches.push({ ids: chunk.map((i) => i.marketId), expectedTotal: chunk.reduce((sum, i) => sum + i.expectedPayout, 0n) });
      queue = queue.slice(chunk.length);
    } else if (chunk.length === 1) {
      singles.push(chunk[0].marketId);
      queue = queue.slice(1);
    } else {
      // Resource limit or a failing id: halve the batch; a lone failing id becomes a single.
      size = Math.max(1, Math.floor(chunk.length / 2));
    }
  }
  singles.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { batches, singles };
}
