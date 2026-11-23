import { describe, expect, it, vi } from "vitest";
import { bucketPoints, type BucketInput, type ChartPeriod } from "../bucket";
import {
  ConcurrencyLimiter,
  TraceVerificationCache,
} from "../trace-overlay-cache";
import {
  alignTracesToBuckets,
  extractValidatedEstimate,
} from "../trace-overlay";
import type { OnChainMarketTrace } from "@/lib/stellar/market-audit";
import type { TraceCheck } from "@/lib/stellar/trace-core";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const AGENT_1 = "GCM7WU3RADBCIKBLGPPAEYV5WHASWMEQX6BU524QR3QFWSE7BIWCXAIF";

function makeTrace(id: string, publishedSec: number, hash = HASH_A): OnChainMarketTrace {
  return {
    index: Number(id) || 0,
    onChainTraceId: id,
    agent: AGENT_1,
    action: "BUY_YES",
    ipfsCid: `QmTrace${id}`,
    publishedAt: publishedSec * 1000,
    traceHash: hash,
  };
}

describe("ConcurrencyLimiter & TraceVerificationCache (Issue #243)", () => {
  it("enforces maxConcurrency and cancels queued tasks on AbortSignal", async () => {
    const limiter = new ConcurrencyLimiter(2);
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];

    const makeTask = (id: string, signal?: AbortSignal) =>
      limiter.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((r) => releases.push(r));
        active--;
        return id;
      }, signal);

    const p1 = makeTask("1");
    const p2 = makeTask("2");
    const ac = new AbortController();
    const p3 = makeTask("3", ac.signal);
    const p4 = makeTask("4");

    expect(limiter.activeCount).toBe(2);
    expect(limiter.pendingCount).toBe(2);

    // Abort queued task 3 before it starts
    ac.abort();
    await expect(p3).rejects.toThrow(/aborted/i);
    expect(limiter.pendingCount).toBe(1);

    releases.shift()!();
    releases.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    releases.shift()!();

    await expect(Promise.all([p1, p2, p4])).resolves.toEqual(["1", "2", "4"]);
    expect(peak).toBe(2);
  });

  it("caches verified results keyed by (traceId, hash), rejects hash mismatch, and expires negative cache after TTL", async () => {
    let now = 1_000;
    const cache = new TraceVerificationCache({ negativeTtlMs: 5_000, now: () => now });

    // Verified result is cached for HASH_A, but NOT served for HASH_B
    const verifier = vi.fn().mockResolvedValue({
      status: "verified",
      computedHash: HASH_A,
      content: { probabilityEstimate: 0.7 },
    } satisfies TraceCheck);

    const r1 = await cache.verify("1", HASH_A, verifier);
    expect(r1.status).toBe("verified");
    const r2 = await cache.verify("1", HASH_A, verifier);
    expect(r2.status).toBe("verified");
    expect(verifier).toHaveBeenCalledTimes(1);

    // Asking for the same trace id with a different hash must NOT return HASH_A's verified result
    const mismatchVerifier = vi.fn().mockResolvedValue({
      status: "verified",
      computedHash: HASH_A, // wrong hash for expected HASH_B!
      content: { probabilityEstimate: 0.7 },
    } satisfies TraceCheck);
    const rWrong = await cache.verify("1", HASH_B, mismatchVerifier);
    expect(rWrong.status).toBe("mismatch");

    // Negative cache holds for TTL then retries
    const flaky = vi
      .fn()
      .mockResolvedValueOnce({ status: "unavailable", reason: "timeout" } satisfies TraceCheck)
      .mockResolvedValueOnce({ status: "verified", computedHash: HASH_A, content: { probabilityEstimate: 0.6 } } satisfies TraceCheck);

    expect((await cache.verify("2", HASH_A, flaky)).status).toBe("unavailable");
    expect((await cache.verify("2", HASH_A, flaky)).status).toBe("unavailable");
    expect(flaky).toHaveBeenCalledTimes(1);

    now += 5_001;
    expect((await cache.verify("2", HASH_A, flaky)).status).toBe("verified");
    expect(flaky).toHaveBeenCalledTimes(2);
  });
});

describe("estimate validation, bucket alignment, and clustering (Issue #243)", () => {
  it("normalizes percent values, clamps to [0, 1], drops invalid estimates and inverted intervals", () => {
    expect(extractValidatedEstimate({ probabilityEstimate: 64.5, confidenceInterval: { lower: 55, upper: 75 } })).toEqual({
      probability: 0.645,
      percent: 64.5,
      ciLowerPercent: 55,
      ciUpperPercent: 75,
      agentLabel: undefined,
    });

    // Missing or NaN probability -> dropped (returns null)
    expect(extractValidatedEstimate({ reasoning: "no number here" })).toBeNull();
    expect(extractValidatedEstimate({ probabilityEstimate: "not-a-number" })).toBeNull();

    // Inverted confidence interval is dropped while valid estimate is kept
    const inverted = extractValidatedEstimate({ probabilityEstimate: 0.5, confidenceInterval: { lower: 0.8, upper: 0.2 } });
    expect(inverted?.percent).toBe(50);
    expect(inverted?.ciLowerPercent).toBeUndefined();
    expect(inverted?.ciUpperPercent).toBeUndefined();
  });

  it("aligns traces onto correct buckets across every period (1H, 1D, 1W, ALL) and clusters same-bucket traces", () => {
    const base = 1_760_000_400; // aligned to 300s & 1800s boundary
    const points: BucketInput[] = [
      { t: base - 86_400 * 10, yesBps: "4500" },
      { t: base - 3_600, yesBps: "5000" },
      { t: base, yesBps: "6000" },
      { t: base + 300, yesBps: "6200" },
    ];

    const traces = [
      makeTrace("1", base + 10, HASH_A),
      makeTrace("2", base + 120, HASH_B), // same 300s bucket as trace 1
    ];

    const checks = new Map<string, TraceCheck>([
      ["1", { status: "verified", computedHash: HASH_A, content: { probabilityEstimate: 0.72, confidenceInterval: { lower: 0.65, upper: 0.8 } } }],
      ["2", { status: "mismatch", computedHash: "c".repeat(64) }],
    ]);

    for (const period of ["1H", "1D", "1W", "ALL"] as ChartPeriod[]) {
      const rows = bucketPoints(points, period, base + 300);
      const { markers, clusters } = alignTracesToBuckets(traces, rows, period, checks);
      expect(markers).toHaveLength(2);
      expect(clusters).toHaveLength(1);
      expect(clusters[0].count).toBe(2);

      const m1 = markers.find((m) => m.onChainTraceId === "1")!;
      const m2 = markers.find((m) => m.onChainTraceId === "2")!;
      expect(m1.status).toBe("verified");
      expect(m1.estimatePercent).toBe(72);
      expect(m1.ciLowerPercent).toBe(65);
      expect(m1.ciUpperPercent).toBe(80);

      // Mismatched trace is unverified, sits on the price line, and carries NO estimate number
      expect(m2.status).toBe("unverified");
      expect(m2.estimatePercent).toBeUndefined();
      expect(m2.y).toBe(m2.marketPriceYes);
    }
  });
});
