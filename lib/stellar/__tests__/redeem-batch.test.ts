import { describe, expect, it } from "vitest";
import { MAX_REDEEM_BATCH, planBatches } from "../redeem-batch";
import type { Redeemable } from "../redeem-all";

const item = (id: number, archived = false): Redeemable =>
  ({ marketId: BigInt(id), settlement: {} as Redeemable["settlement"], yes: 1n, no: 0n, expectedPayout: 10n, archived });

describe("redeem_many planner (#271)", () => {
  it("sorts and deduplicates ids, caps batches at 46 and routes archived items to singles", async () => {
    const items = [...Array.from({ length: 50 }, (_, i) => item(50 - i)), item(3), item(99, true)];
    const plan = await planBatches(items, async () => ({ ok: true }));
    expect(plan.batches.map((b) => b.ids.length)).toEqual([MAX_REDEEM_BATCH, 4]);
    expect(plan.batches[0].ids[0]).toBe(1n);
    expect(plan.batches[0].expectedTotal).toBe(460n);
    expect(plan.singles).toEqual([99n]);
  });

  it("shrinks on resource errors and isolates an id that cannot be batched", async () => {
    const plan = await planBatches([1, 2, 3, 4].map((i) => item(i)), async (ids) =>
      ids.length > 2 ? { ok: false, reason: "resource" } : ids.includes(3n) && ids.length > 1 ? { ok: false, reason: "failed" }
        : ids.includes(3n) ? { ok: false, reason: "failed" } : { ok: true });
    expect(plan.batches.map((b) => b.ids)).toEqual([[1n, 2n], [4n]]);
    expect(plan.singles).toEqual([3n]);
  });
});
