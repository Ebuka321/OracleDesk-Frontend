"use client";

import { useSyncExternalStore } from "react";
import { rpcPool } from "@/lib/stellar/clients";
import type { EndpointStats } from "@/lib/stellar/rpc-pool";
import { scheduler, type RpcPriority } from "@/lib/stellar/rpc-scheduler";

const EMPTY: EndpointStats[] = [];
const noop = () => () => {};

export function useRpcPoolStats() {
  const pool = rpcPool();
  const stats = useSyncExternalStore(pool?.subscribe ?? noop, pool?.getSnapshot ?? (() => EMPTY), () => EMPTY);
  return { stats, current: pool?.current() ?? null, pinned: pool?.pinnedUrl() ?? null, degraded: pool?.isDegraded() ?? false };
}

const ms = (v: number | null) => (v === null ? "–" : `${Math.round(v)} ms`);

/** Live pool state: endpoints, latency, errors, 429s, ledger lag, current/pinned. */
export function RpcPanel() {
  const { stats, current, pinned } = useRpcPoolStats();
  if (stats.length === 0) return <p className="text-xs">RPC pool not started (server render).</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px] font-data-mono">
        <thead>
          <tr className="text-start text-outline">
            <th className="pe-2">Endpoint</th><th className="pe-2">State</th><th className="pe-2">p50</th><th className="pe-2">p95</th>
            <th className="pe-2">Err</th><th className="pe-2">429</th><th className="pe-2">Ledger</th><th className="pe-2">Lag</th><th />
          </tr>
        </thead>
        <tbody>
          {stats.map((s) => (
            <tr key={s.url} title={s.lastError}>
              <td className="pe-2 break-all">{s.url}</td>
              <td className="pe-2">{s.state}</td>
              <td className="pe-2">{ms(s.p50Ms)}</td>
              <td className="pe-2">{ms(s.p95Ms)}</td>
              <td className="pe-2">{Math.round(s.errorRate * 100)}%</td>
              <td className="pe-2">{s.rateLimited}</td>
              <td className="pe-2">{s.latestLedger ?? "–"}</td>
              <td className="pe-2">{s.lagLedgers ?? "–"}</td>
              <td>{s.url === pinned ? "pinned" : s.url === current ? "current" : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <SchedulerPanel />
    </div>
  );
}

export function SchedulerPanel() {
  const sched = scheduler();
  const s = useSyncExternalStore(sched.subscribe, sched.stats, sched.stats);
  const priorities: RpcPriority[] = ["submit", "interactive", "normal", "background"];
  const now = s.now;
  return (
    <div className="mt-3 space-y-2 border-t border-outline-variant pt-2 text-[11px] font-data-mono">
      <div className="flex flex-wrap gap-3">
        {priorities.map((p) => (
          <span key={p}>
            {p}: q={s.priorities[p].depth} p95={ms(s.priorities[p].waitP95Ms)}
          </span>
        ))}
        <span>shed={s.shedBackground}</span>
      </div>
      {s.buckets.length > 0 && (
        <table className="w-full text-[11px] font-data-mono">
          <thead>
            <tr className="text-left text-outline">
              <th className="pr-2">URL</th><th className="pr-2">Class</th><th className="pr-2">Rate</th><th className="pr-2">Tokens</th><th>Paused</th>
            </tr>
          </thead>
          <tbody>
            {s.buckets.map((b) => {
              const pauseSec = b.pausedUntil > now ? Math.ceil((b.pausedUntil - now) / 1000) : 0;
              return (
                <tr key={`${b.url}|${b.methodClass}`}>
                  <td className="pr-2 break-all">{b.url}</td>
                  <td className="pr-2">{b.methodClass}</td>
                  <td className="pr-2">{b.rate.toFixed(1)}/s</td>
                  <td className="pr-2">{b.tokens.toFixed(1)}/{b.burst}</td>
                  <td>{pauseSec > 0 ? `${pauseSec}s` : "–"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Shown to everyone when no RPC endpoint is healthy or interactive calls are queuing. */
export function RpcDegradedBanner() {
  const { degraded, stats } = useRpcPoolStats();
  const sched = scheduler();
  const schedStats = useSyncExternalStore(sched.subscribe, sched.stats, sched.stats);
  const queuing = (schedStats.priorities.interactive.waitP95Ms ?? 0) > 2_000;
  if (!degraded && !queuing) return null;
  const limited = stats.some((s) => s.rateLimited > 0 && s.state === "degraded");
  return (
    <div role="status" className="fixed top-16 inset-x-0 z-40 bg-error-container text-on-error-container text-center text-sm py-1.5 px-4">
      {queuing && !degraded
        ? "Stellar RPC is busy: requests are being queued."
        : limited
          ? "Stellar RPC is degraded: the network is rate limiting requests. Prices may be delayed."
          : "Stellar RPC is degraded. Prices and balances may be delayed or unavailable."}
    </div>
  );
}
