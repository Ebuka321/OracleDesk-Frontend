/**
 * Pure alignment, estimate validation, clamping, and clustering for overlaying
 * verified reasoning-registry agent estimates on the on-chain price chart
 * (Issue #243).
 *
 * Clock note:
 *  - `ChartRow.t` is unix seconds (Soroban ledger close time).
 *  - `OnChainMarketTrace.publishedAt` is unix milliseconds derived from
 *    `Number(trace.published_at) * 1000` (on-chain ledger timestamp in seconds).
 *    Converting `Math.floor(publishedAt / 1000)` aligns directly with the
 *    ledger-time axis. Any wall-clock timestamp inside the IPFS JSON payload
 *    may differ from ledger close time and is never used for X-axis placement.
 */

import { bucketStart, type ChartPeriod, type ChartRow } from "./bucket";
import type { OnChainMarketTrace } from "@/lib/stellar/market-audit";
import type { TraceCheck } from "@/lib/stellar/trace-core";
import { validateTraceContent } from "@/lib/stellar/trace-schema";
import { shortAddress } from "@/lib/stellar/units";

export interface ExtractedEstimate {
  /** Normalized probability in [0, 1]. */
  probability: number;
  /** Display percentage in [0, 100]. */
  percent: number;
  /** Optional validated & clamped confidence interval in [0, 100]. */
  ciLowerPercent?: number;
  ciUpperPercent?: number;
  agentLabel?: string;
}

export type OverlayMarkerStatus = "verified" | "unverified";

export interface TraceOverlayMarker {
  id: string;
  onChainTraceId: string;
  agent: string;
  agentDisplay: string;
  /** Unix seconds (ledger time). */
  publishedSec: number;
  /** Aligned bucket timestamp in unix seconds. */
  bucketT: number;
  /** Y position (0..100): verified estimate percent, or the price line when unverified. */
  y: number;
  /** Market YES price at this bucket (0..100). */
  marketPriceYes: number;
  status: OverlayMarkerStatus;
  /** Present ONLY when `status === "verified"`. */
  estimatePercent?: number;
  ciLowerPercent?: number;
  ciUpperPercent?: number;
  /** Reason when unverified (e.g. "pending", "mismatch", "unavailable"). */
  unverifiedReason?: string;
  /** Horizontal offset index within a multi-trace cluster (0-based). */
  clusterIndex: number;
  /** Total markers in this bucket cluster. */
  clusterSize: number;
  /** Accessible description for screen readers and keyboard navigation. */
  ariaLabel: string;
}

export interface TraceBucketCluster {
  bucketT: number;
  marketPriceYes: number;
  markers: TraceOverlayMarker[];
  count: number;
}

/**
 * Extracts and validates the probability estimate and optional confidence
 * interval from verified trace content. Returns `null` if the estimate is
 * missing or invalid (caller must drop the marker rather than drawing nonsense).
 */
export function extractValidatedEstimate(content: unknown): ExtractedEstimate | null {
  const validated = validateTraceContent(content);
  if (!validated.ok) return null;

  const prob = validated.data.probabilityEstimate;
  if (typeof prob !== "number" || !Number.isFinite(prob)) return null;
  const clampedProb = Math.min(1, Math.max(0, prob));

  let ciLowerPercent: number | undefined;
  let ciUpperPercent: number | undefined;

  const ci = validated.data.confidenceInterval;
  if (ci) {
    const low = Number(ci.lower);
    const high = Number(ci.upper);
    if (Number.isFinite(low) && Number.isFinite(high)) {
      const clampedLow = Math.min(1, Math.max(0, low));
      const clampedHigh = Math.min(1, Math.max(0, high));
      if (clampedLow <= clampedHigh) {
        ciLowerPercent = Math.round(clampedLow * 1000) / 10;
        ciUpperPercent = Math.round(clampedHigh * 1000) / 10;
      }
    }
  }

  return {
    probability: clampedProb,
    percent: Math.round(clampedProb * 1000) / 10,
    ciLowerPercent,
    ciUpperPercent,
    agentLabel: validated.data.agent,
  };
}

/** Converts `publishedAt` ms to unix seconds on the ledger-time axis. */
export function publishedMsToUnixSeconds(publishedAtMs: number): number {
  if (!Number.isFinite(publishedAtMs) || publishedAtMs < 0) return 0;
  return Math.floor(publishedAtMs / 1000);
}

/** Finds the active step-line YES price at or immediately preceding `bucketT`. */
function stepPriceAt(rows: readonly ChartRow[], bucketT: number): number {
  let price = rows[0]?.yes ?? 50;
  for (const row of rows) {
    if (row.t > bucketT) break;
    price = row.yes;
  }
  return price;
}

/**
 * Aligns traces to the bucketed rows for `period`, builds verified/unverified
 * markers, and clusters multiple traces landing in the same bucket.
 *
 * Security invariant: a numeric estimate & confidence whisker are populated
 * ONLY when `checks.get(trace.onChainTraceId)?.status === "verified"` AND
 * `extractValidatedEstimate` succeeds. If a verified trace has an invalid or
 * missing estimate, the marker is dropped rather than drawing nonsense.
 */
export function alignTracesToBuckets(
  traces: readonly OnChainMarketTrace[],
  rows: readonly ChartRow[],
  period: ChartPeriod,
  checks: ReadonlyMap<string, TraceCheck>,
): { markers: TraceOverlayMarker[]; clusters: TraceBucketCluster[] } {
  if (!traces.length || !rows.length) {
    return { markers: [], clusters: [] };
  }

  const minT = rows[0].t;
  const maxT = rows[rows.length - 1].t;

  const grouped = new Map<number, Array<{ trace: OnChainMarketTrace; publishedSec: number; check?: TraceCheck; estimate?: ExtractedEstimate | null }>>();

  for (const trace of traces) {
    const publishedSec = publishedMsToUnixSeconds(trace.publishedAt);
    const bucketT = bucketStart(publishedSec, period);

    // Filter to the visible chart range (inclusive of boundary buckets)
    if (bucketT < minT || bucketT > maxT) continue;

    const check = checks.get(trace.onChainTraceId);
    let estimate: ExtractedEstimate | null | undefined;
    if (check?.status === "verified") {
      estimate = extractValidatedEstimate(check.content);
      // Drop a verified trace whose estimate is missing or invalid rather than drawing nonsense
      if (!estimate) continue;
    }

    const list = grouped.get(bucketT) ?? [];
    list.push({ trace, publishedSec, check, estimate });
    grouped.set(bucketT, list);
  }

  const clusters: TraceBucketCluster[] = [];
  const allMarkers: TraceOverlayMarker[] = [];

  const sortedBucketKeys = [...grouped.keys()].sort((a, b) => a - b);

  for (const bucketT of sortedBucketKeys) {
    const items = grouped.get(bucketT)!;
    items.sort((a, b) => a.publishedSec - b.publishedSec || a.trace.onChainTraceId.localeCompare(b.trace.onChainTraceId));
    const marketPriceYes = stepPriceAt(rows, bucketT);
    const clusterMarkers: TraceOverlayMarker[] = [];

    items.forEach((item, idx) => {
      const { trace, publishedSec, check, estimate } = item;
      const isVerified = check?.status === "verified" && Boolean(estimate);
      const agentDisplay = estimate?.agentLabel || shortAddress(trace.agent) || "Agent";
      const isoTime = new Date(publishedSec * 1000).toISOString();

      let ariaLabel: string;
      if (isVerified && estimate) {
        const ciPart =
          estimate.ciLowerPercent !== undefined && estimate.ciUpperPercent !== undefined
            ? `, confidence interval ${estimate.ciLowerPercent.toFixed(1)}% to ${estimate.ciUpperPercent.toFixed(1)}%`
            : "";
        ariaLabel = `${agentDisplay} at ${isoTime}, verified estimate ${estimate.percent.toFixed(1)}%${ciPart}`;
      } else {
        const reason =
          check?.status === "mismatch"
            ? "hash mismatch"
            : check?.status === "unavailable"
              ? "unreachable"
              : "unverified";
        ariaLabel = `${agentDisplay} at ${isoTime}, ${reason} trace, no estimate displayed`;
      }

      const marker: TraceOverlayMarker = {
        id: `${trace.onChainTraceId}:${bucketT}`,
        onChainTraceId: trace.onChainTraceId,
        agent: trace.agent,
        agentDisplay,
        publishedSec,
        bucketT,
        y: isVerified && estimate ? estimate.percent : marketPriceYes,
        marketPriceYes,
        status: isVerified ? "verified" : "unverified",
        ...(isVerified && estimate
          ? {
              estimatePercent: estimate.percent,
              ciLowerPercent: estimate.ciLowerPercent,
              ciUpperPercent: estimate.ciUpperPercent,
            }
          : {
              unverifiedReason: check?.status ?? "pending",
            }),
        clusterIndex: idx,
        clusterSize: items.length,
        ariaLabel,
      };
      clusterMarkers.push(marker);
      allMarkers.push(marker);
    });

    clusters.push({
      bucketT,
      marketPriceYes,
      markers: clusterMarkers,
      count: clusterMarkers.length,
    });
  }

  return { markers: allMarkers, clusters };
}
