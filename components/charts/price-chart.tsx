"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Area,
  Line,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { PricePoint } from "@/lib/stellar/price-history";
import {
  CHART_PERIODS,
  handleRequest,
  type BucketInput,
  type BucketRequest,
  type BucketResponse,
  type ChartPeriod,
  type ChartRow,
} from "@/lib/charts/bucket";
import {
  enumerateOnChainMarketTraces,
  type OnChainMarketTrace,
} from "@/lib/stellar/market-audit";
import { verifyTraceInWorker, type TraceCheck } from "@/lib/stellar/trace";
import {
  defaultTraceVerificationCache,
  type TraceVerificationCache,
} from "@/lib/charts/trace-overlay-cache";
import {
  alignTracesToBuckets,
  publishedMsToUnixSeconds,
  type TraceOverlayMarker,
} from "@/lib/charts/trace-overlay";

export const PRICE_CHART_HEIGHT = 340;

const pad = (n: number) => String(n).padStart(2, "0");

const formatTime = (t: number, period: ChartPeriod) => {
  const d = new Date(t * 1000);
  if (period === "ALL") return `${d.toLocaleString(undefined, { month: "short", day: "numeric" })}`;
  if (period === "1W") return `${d.toLocaleString(undefined, { weekday: "short" })} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const tickStyle = { fontSize: 10, fill: "var(--chart-tick)", fontFamily: "var(--font-geist-sans)" };

interface TooltipProps {
  active?: boolean;
  label?: string | number;
  payload?: Array<{ payload?: ChartRow }>;
  period?: ChartPeriod;
}

const PriceTooltip = ({ active, payload, label, period }: TooltipProps) => {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <div className="bg-on-background text-surface px-3 py-2 rounded shadow-xl font-data-mono text-[11px] border border-primary/20">
      <p className="text-outline mb-1">{typeof label === "number" ? formatTime(label, period ?? "1D") : label}</p>
      <p className="font-bold" style={{ color: "var(--chart-yes)" }}>YES {row.yes.toFixed(1)}%</p>
      <p className="font-bold" style={{ color: "var(--chart-no)" }}>NO {(100 - row.yes).toFixed(1)}%</p>
      {row.kind === "resolved" && <p className="text-outline mt-1">RESOLVED</p>}
    </div>
  );
};

export interface PriceChartProps {
  points: readonly PricePoint[];
  defaultPeriod?: ChartPeriod;
  /** Optional on-chain market id to lazily load and verify reasoning-registry agent traces. */
  onChainMarketId?: string | null;
  /** Optional pre-supplied traces (overrides on-chain enumeration, useful for SSR/tests). */
  traces?: readonly OnChainMarketTrace[];
  /** Injectable trace verifier for tests; defaults to `verifyTraceInWorker`. */
  verifyTrace?: (trace: OnChainMarketTrace, signal: AbortSignal) => Promise<TraceCheck>;
  /** Injectable verification cache; defaults to `defaultTraceVerificationCache`. */
  verificationCache?: TraceVerificationCache;
}

/** Step-line price chart fed by real Soroban trade events, with an optional
 * verified agent-estimate overlay layer (Issue #243). The chart body mounts
 * only on the client so recharts never measures a zero-size container during
 * prerender; the worker keeps bucketing off the main thread. */
export default function PriceChart({
  points,
  defaultPeriod = "1D",
  onChainMarketId,
  traces: externalTraces,
  verifyTrace,
  verificationCache = defaultTraceVerificationCache,
}: PriceChartProps) {
  const [period, setPeriod] = useState<ChartPeriod>(defaultPeriod);
  const [rows, setRows] = useState<ChartRow[]>([]);
  const [mounted, setMounted] = useState(false);
  const [enumeratedTraces, setEnumeratedTraces] = useState<OnChainMarketTrace[]>([]);
  const [checks, setChecks] = useState<Map<string, TraceCheck>>(() => new Map());
  const [activeMarkerId, setActiveMarkerId] = useState<string | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const markerRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    // Defer past the effect's synchronous window: the chart mounts after the
    // first paint, which is also what keeps recharts out of the prerender.
    const frame = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (typeof Worker === "undefined") return;
    try {
      const worker = new Worker(new URL("../../lib/charts/bucket.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<BucketResponse>) => {
        if (event.data.id === requestIdRef.current) setRows(event.data.rows);
      };
      workerRef.current = worker;
    } catch {
      workerRef.current = null;
    }
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, []);

  const inputs = useMemo<BucketInput[]>(
    () => points.map((point) => ({ t: point.time, yesBps: point.yesBps.toString(), ...(point.kind ? { kind: point.kind } : {}) })),
    [points],
  );

  useEffect(() => {
    const endT = inputs[inputs.length - 1]?.t ?? 0;
    const request: BucketRequest = { id: ++requestIdRef.current, points: inputs, period, endT };
    if (workerRef.current) workerRef.current.postMessage(request);
    else setRows(handleRequest(request).rows);
  }, [inputs, period]);

  // Lazily enumerate on-chain traces when onChainMarketId is supplied and no external traces were provided.
  useEffect(() => {
    if (externalTraces || !onChainMarketId || !/^\d+$/.test(onChainMarketId)) {
      setEnumeratedTraces([]);
      return;
    }
    const controller = new AbortController();
    void enumerateOnChainMarketTraces(onChainMarketId, undefined, { signal: controller.signal })
      .then((list) => {
        if (!controller.signal.aborted) setEnumeratedTraces(list);
      })
      .catch(() => {
        if (!controller.signal.aborted) setEnumeratedTraces([]);
      });
    return () => controller.abort();
  }, [onChainMarketId, externalTraces]);

  const allTraces = externalTraces ?? enumeratedTraces;

  // Lazy, visible-range-first verification with bounded concurrency and cancellation on period change / unmount.
  useEffect(() => {
    if (!allTraces.length || !rows.length) return;
    const minT = rows[0].t;
    const maxT = rows[rows.length - 1].t;
    const visibleTraces = allTraces.filter((tr) => {
      const sec = publishedMsToUnixSeconds(tr.publishedAt);
      return sec >= minT && sec <= maxT;
    });
    if (!visibleTraces.length) return;

    const controller = new AbortController();
    const runVerify =
      verifyTrace ??
      ((tr: OnChainMarketTrace, sig: AbortSignal) => verifyTraceInWorker(tr.ipfsCid, tr.traceHash, { signal: sig }));

    for (const trace of visibleTraces) {
      const cached = verificationCache.get(trace.onChainTraceId, trace.traceHash);
      if (cached) {
        setChecks((prev) => {
          if (prev.get(trace.onChainTraceId) === cached) return prev;
          const next = new Map(prev);
          next.set(trace.onChainTraceId, cached);
          return next;
        });
        continue;
      }

      void verificationCache
        .verify(trace.onChainTraceId, trace.traceHash, (sig) => runVerify(trace, sig), controller.signal)
        .then((check) => {
          if (controller.signal.aborted) return;
          setChecks((prev) => {
            const next = new Map(prev);
            next.set(trace.onChainTraceId, check);
            return next;
          });
        })
        .catch(() => {
          // Aborted or failed; unverified hollow marker remains on the price line
        });
    }

    return () => controller.abort();
  }, [allTraces, rows, period, verifyTrace, verificationCache]);

  const { markers, clusters } = useMemo(
    () => alignTracesToBuckets(allTraces, rows, period, checks),
    [allTraces, rows, period, checks],
  );

  const activeMarker: TraceOverlayMarker | null = useMemo(
    () => markers.find((m) => m.id === activeMarkerId) ?? null,
    [markers, activeMarkerId],
  );

  const resolved = rows.length ? [...rows].reverse().find((row) => row.kind === "resolved") : undefined;

  const handleMarkerKeyDown = (index: number, event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      const next = (index + 1) % markers.length;
      markerRefs.current[next]?.focus();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      const prev = (index - 1 + markers.length) % markers.length;
      markerRefs.current[prev]?.focus();
    } else if (event.key === "Escape") {
      setActiveMarkerId(null);
    }
  };

  return (
    <div className="bg-surface-container-lowest border border-outline-variant p-6 rounded relative overflow-hidden">
      {/* Controls */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4">
        <div className="font-label-caps text-label-caps text-on-surface-variant">
          ON-CHAIN PRICE · {rows.length ? `${rows.length} BUCKETS` : "NO TRADES YET"}
        </div>
        <div className="flex gap-1">
          {CHART_PERIODS.map((option) => (
            <button
              key={option}
              onClick={() => setPeriod(option)}
              className={`px-3 py-1 rounded font-label-caps text-label-caps motion-reduce:transition-none transition-all ${
                period === option
                  ? "bg-primary text-primary-foreground"
                  : "bg-surface-container text-on-surface-variant hover:bg-surface-container-high"
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      {/* Legend (shape + fill distinguish verified vs unverified, never colour alone) */}
      <div className="flex flex-wrap items-center gap-4 mb-4">
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-0.5 rounded-full inline-block" style={{ background: "var(--chart-yes)" }} />
          <span className="font-label-caps text-[10px] text-on-surface-variant">YES</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="w-3 h-0.5 rounded-full inline-block" style={{ background: "var(--chart-no)" }} />
          <span className="font-label-caps text-[10px] text-on-surface-variant">NO</span>
        </div>
        {markers.length > 0 && (
          <>
            <div className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="w-2.5 h-2.5 rounded-full inline-block"
                style={{ background: "var(--chart-yes)", border: "1.5px solid var(--chart-yes)" }}
              />
              <span className="font-label-caps text-[10px] text-on-surface-variant">VERIFIED ESTIMATE</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="w-2.5 h-2.5 rounded-full inline-block bg-surface-container-lowest"
                style={{ border: "1.5px solid var(--chart-axis)" }}
              />
              <span className="font-label-caps text-[10px] text-on-surface-variant">UNVERIFIED TRACE</span>
            </div>
          </>
        )}
        {resolved && (
          <div className="flex items-center gap-1.5 ms-2">
            <span className="w-4 h-0.5 border-t-2 border-dashed inline-block" style={{ borderColor: "var(--chart-axis)" }} />
            <span className="font-label-caps text-[10px]" style={{ color: "var(--chart-axis)" }}>RESOLVED</span>
          </div>
        )}
      </div>

      <div className="h-[340px] w-full relative">
        {mounted && rows.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={PRICE_CHART_HEIGHT}>
            <ComposedChart data={rows} margin={{ top: 8, right: 8, left: -24, bottom: 0 }}>
              <defs>
                <linearGradient id="priceChartYes" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--chart-yes)" stopOpacity={0.18} />
                  <stop offset="95%" stopColor="var(--chart-yes)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" strokeOpacity={0.3} />
              <XAxis
                dataKey="t"
                type="number"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(t: number) => formatTime(t, period)}
                tick={tickStyle}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                domain={[0, 100]}
                tickFormatter={(v) => `${v}%`}
                tick={tickStyle}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip content={<PriceTooltip period={period} />} />
              {resolved && (
                <ReferenceLine
                  y={resolved.yes}
                  stroke="var(--chart-axis)"
                  strokeDasharray="6 4"
                  strokeWidth={1.5}
                  label={{ value: "RESOLVED", position: "insideTopRight", fontSize: 10, fill: "var(--chart-axis)" }}
                />
              )}
              <Area
                type="stepAfter"
                dataKey="yes"
                stroke="none"
                fill="url(#priceChartYes)"
                isAnimationActive={false}
              />
              <Line
                type="stepAfter"
                dataKey="yes"
                stroke="var(--chart-yes)"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, fill: "var(--chart-yes)" }}
                isAnimationActive={false}
              />
              {/* Confidence-interval whiskers for verified traces only */}
              {markers.map((marker) =>
                marker.status === "verified" &&
                marker.ciLowerPercent !== undefined &&
                marker.ciUpperPercent !== undefined ? (
                  <ReferenceLine
                    key={`ci-${marker.id}`}
                    segment={[
                      { x: marker.bucketT, y: marker.ciLowerPercent },
                      { x: marker.bucketT, y: marker.ciUpperPercent },
                    ]}
                    stroke="var(--chart-yes)"
                    strokeWidth={2}
                    strokeOpacity={0.6}
                  />
                ) : null,
              )}
              {/* Agent trace markers: filled at estimate when verified, hollow on price line when unverified */}
              {markers.map((marker) => (
                <ReferenceDot
                  key={marker.id}
                  x={marker.bucketT}
                  y={marker.y}
                  r={marker.status === "verified" ? 5 : 4.5}
                  fill={marker.status === "verified" ? "var(--chart-yes)" : "var(--surface-container-lowest, #fff)"}
                  stroke={marker.status === "verified" ? "var(--chart-yes)" : "var(--chart-axis)"}
                  strokeWidth={2}
                  label={
                    marker.clusterSize > 1 && marker.clusterIndex === 0
                      ? { value: String(marker.clusterSize), position: "top", fontSize: 9, fill: "var(--chart-axis)" }
                      : undefined
                  }
                />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-full w-full flex items-center justify-center rounded border border-dashed border-outline-variant">
            <p className="font-label-caps text-label-caps text-on-surface-variant text-center px-6">
              {mounted
                ? "NO ON-CHAIN TRADES YET — THE PRICE LINE STARTS AT THE FIRST TRADE"
                : "LOADING PRICE HISTORY…"}
            </p>
          </div>
        )}

        {/* Focus/hover popover for the active trace marker */}
        {activeMarker && (
          <div
            role="status"
            aria-live="polite"
            className="absolute top-2 right-2 z-10 bg-on-background text-surface px-3 py-2 rounded shadow-xl font-data-mono text-[11px] border border-primary/20 max-w-xs"
          >
            <p className="font-bold">{activeMarker.agentDisplay}</p>
            <p className="text-outline">{formatTime(activeMarker.publishedSec, period)}</p>
            {activeMarker.status === "verified" && activeMarker.estimatePercent !== undefined ? (
              <>
                <p style={{ color: "var(--chart-yes)" }}>
                  Verified estimate: {activeMarker.estimatePercent.toFixed(1)}%
                </p>
                {activeMarker.ciLowerPercent !== undefined && activeMarker.ciUpperPercent !== undefined && (
                  <p className="text-outline">
                    CI: {activeMarker.ciLowerPercent.toFixed(1)}% – {activeMarker.ciUpperPercent.toFixed(1)}%
                  </p>
                )}
              </>
            ) : (
              <p className="text-outline">Unverified trace ({activeMarker.unverifiedReason ?? "unverified"})</p>
            )}
          </div>
        )}
      </div>

      {/* Keyboard-accessible marker strip (ArrowLeft / ArrowRight navigation, visible focus ring, focus+hover popover) */}
      {markers.length > 0 && (
        <div
          role="group"
          aria-label="Agent reasoning trace markers"
          className="mt-3 flex flex-wrap gap-1.5"
        >
          {markers.map((marker, idx) => (
            <button
              key={marker.id}
              ref={(el) => {
                markerRefs.current[idx] = el;
              }}
              type="button"
              aria-label={marker.ariaLabel}
              onFocus={() => setActiveMarkerId(marker.id)}
              onBlur={() => setActiveMarkerId((curr) => (curr === marker.id ? null : curr))}
              onMouseEnter={() => setActiveMarkerId(marker.id)}
              onMouseLeave={() => setActiveMarkerId((curr) => (curr === marker.id ? null : curr))}
              onKeyDown={(e) => handleMarkerKeyDown(idx, e)}
              className="inline-flex items-center gap-1.5 px-2 py-1 rounded border border-outline-variant bg-surface-container text-[10px] font-data-mono text-on-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary motion-reduce:transition-none"
            >
              <span
                aria-hidden="true"
                className="w-2 h-2 rounded-full inline-block"
                style={
                  marker.status === "verified"
                    ? { background: "var(--chart-yes)", border: "1.5px solid var(--chart-yes)" }
                    : { background: "transparent", border: "1.5px solid var(--chart-axis)" }
                }
              />
              <span>{marker.agentDisplay}</span>
              {marker.status === "verified" && marker.estimatePercent !== undefined && (
                <span>{marker.estimatePercent.toFixed(1)}%</span>
              )}
              {marker.clusterSize > 1 && marker.clusterIndex === 0 && (
                <span className="text-on-surface-variant">({clusters.find((c) => c.bucketT === marker.bucketT)?.count})</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Visually hidden text alternative for screen readers */}
      {markers.length > 0 && (
        <table className="sr-only">
          <caption>Agent reasoning estimates overlaid on price chart</caption>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Time</th>
              <th>Status</th>
              <th>Estimate</th>
              <th>Confidence Interval</th>
            </tr>
          </thead>
          <tbody>
            {markers.map((marker) => (
              <tr key={`sr-${marker.id}`}>
                <td>{marker.agentDisplay}</td>
                <td>{new Date(marker.publishedSec * 1000).toISOString()}</td>
                <td>{marker.status === "verified" ? "Verified" : "Unverified"}</td>
                <td>
                  {marker.status === "verified" && marker.estimatePercent !== undefined
                    ? `${marker.estimatePercent.toFixed(1)}%`
                    : "Not displayed"}
                </td>
                <td>
                  {marker.status === "verified" &&
                  marker.ciLowerPercent !== undefined &&
                  marker.ciUpperPercent !== undefined
                    ? `${marker.ciLowerPercent.toFixed(1)}% to ${marker.ciUpperPercent.toFixed(1)}%`
                    : "None"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
