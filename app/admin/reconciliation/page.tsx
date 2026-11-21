"use client";

import React, { useState } from "react";
import Link from "next/link";
import { RequireWallet } from "@/components/require-wallet";
import { ReconcileRunDetail } from "@/components/admin/reconcile-run-detail";
import { useAdminPermissions } from "@/lib/admin/useAdminPermissions";
import { useReconcileRuns, useTriggerReconcile } from "@/lib/hooks/useReconciliation";
import { useWallet } from "@/lib/contexts/WalletContext";

function duration(startedAt: string, finishedAt: string | null): string {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return "—";
  const end = finishedAt ? Date.parse(finishedAt) : Date.now();
  if (!Number.isFinite(end)) return "—";
  return `${Math.max(0, Math.round((end - start) / 1_000))}s`;
}

export default function ReconciliationPage() {
  return (
    <RequireWallet
      title="Restricted Access"
      description="The reconciliation console requires a secure wallet connection."
    >
      <ReconciliationContent />
    </RequireWallet>
  );
}

function ReconciliationContent() {
  const { address } = useWallet();
  const { can, isLoading: permissionsLoading } = useAdminPermissions();
  const runsQuery = useReconcileRuns();
  const trigger = useTriggerReconcile();
  const [pickedRunId, setPickedRunId] = useState<string | null>(null);
  const selectedRunId = trigger.runId ?? pickedRunId;
  const [dryRun, setDryRun] = useState(true);
  const [maxMarkets, setMaxMarkets] = useState(100);

  if (permissionsLoading) {
    return <main className="flex-grow flex items-center justify-center p-gutter"><p className="animate-pulse text-on-surface-variant">Resolving authorization…</p></main>;
  }

  if (!can("reconciliation.run")) {
    return (
      <main className="flex-grow flex items-center justify-center p-gutter">
        <div className="max-w-md w-full text-center space-y-3 bg-white p-10 rounded-xl border border-outline-variant">
          <h1 className="font-headline-md text-headline-md">Access Denied</h1>
          <p className="text-on-surface-variant">Your wallet is not authorized to run market reconciliation.</p>
          <p className="font-data-mono text-xs break-all text-on-surface-variant">{address}</p>
        </div>
      </main>
    );
  }

  const runs = runsQuery.data ?? [];
  const highlighted = trigger.runId;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (maxMarkets > 1_000) {
      const ok = window.confirm(`This uses up to ${maxMarkets} RPC calls on the backend. Continue?`);
      if (!ok) return;
    }
    await trigger.mutateAsync({ dryRun, maxMarkets });
  };

  return (
    <main className="flex-grow max-w-container-max-width mx-auto px-gutter py-12 w-full space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-display-lg text-display-lg text-primary">Reconciliation Console</h1>
          <p className="text-sm text-on-surface-variant">
            Compare backend market state with market-core and inspect drift findings.
          </p>
        </div>
        <Link href="/admin" className="text-primary underline text-sm">Admin Control Center</Link>
      </div>

      <form onSubmit={(event) => void submit(event)} className="bg-white border border-outline-variant rounded-xl p-5 flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-xs">
          Max markets
          <input
            type="number"
            min={1}
            max={5_000}
            value={maxMarkets}
            onChange={(event) => setMaxMarkets(Math.max(1, Math.min(5_000, Number(event.target.value) || 1)))}
            className="bg-surface border border-outline-variant rounded px-2 py-1 font-data-mono"
          />
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={dryRun} onChange={(event) => setDryRun(event.target.checked)} />
          Dry run (report only)
        </label>
        <button
          type="submit"
          disabled={trigger.isPending}
          className="bg-primary text-primary-foreground px-4 py-2 rounded-lg text-xs disabled:opacity-60"
        >
          {trigger.isPending ? "Starting…" : "Run reconciliation"}
        </button>
        {trigger.isError && <p className="text-error text-xs w-full">{trigger.error instanceof Error ? trigger.error.message : "Could not start the run."}</p>}
      </form>

      {runsQuery.isError && (
        <p className="text-error text-sm">
          Couldn&apos;t load runs: {runsQuery.error instanceof Error ? runsQuery.error.message : "unknown error"}
        </p>
      )}

      <section className="bg-white border border-outline-variant rounded-xl overflow-hidden" aria-label="Reconciliation runs">
        <div className="p-5 border-b border-outline-variant flex items-center justify-between">
          <h2 className="font-headline-sm text-headline-sm">Runs</h2>
          <button type="button" onClick={() => void runsQuery.refetch()} className="text-primary underline text-xs">Refresh</button>
        </div>
        {runs.length === 0 ? (
          <p className="p-6 text-sm text-on-surface-variant">No reconciliation runs yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start text-sm">
              <thead className="bg-surface-container-low text-on-surface-variant text-[11px] uppercase tracking-wide">
                <tr>
                  <th className="px-4 py-2">Run</th>
                  <th className="px-4 py-2">Started</th>
                  <th className="px-4 py-2">Duration</th>
                  <th className="px-4 py-2">Scanned</th>
                  <th className="px-4 py-2">Repaired</th>
                  <th className="px-4 py-2">Reported</th>
                  <th className="px-4 py-2">Deferred</th>
                  <th className="px-4 py-2">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant">
                {runs.map((run) => (
                  <tr
                    key={run.id}
                    className={`cursor-pointer ${selectedRunId === run.id ? "bg-primary-container" : ""} ${highlighted === run.id ? "font-bold" : ""}`}
                    onClick={() => setPickedRunId(run.id)}
                  >
                    <td className="px-4 py-2 font-data-mono text-xs break-all">{run.id}</td>
                    <td className="px-4 py-2">{new Date(run.startedAt).toLocaleString()}</td>
                    <td className="px-4 py-2 font-data-mono">{duration(run.startedAt, run.finishedAt)}</td>
                    <td className="px-4 py-2 font-data-mono">{run.scanned}</td>
                    <td className="px-4 py-2 font-data-mono">{run.repaired}</td>
                    <td className="px-4 py-2 font-data-mono">{run.reported}</td>
                    <td className="px-4 py-2 font-data-mono">{run.deferred}</td>
                    <td className="px-4 py-2 text-xs">
                      {run.error
                        ? run.error.includes("another instance is reconciling") ? "Skipped (lock held)" : "Failed"
                        : run.finishedAt ? "Complete" : "Running"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ReconcileRunDetail key={selectedRunId ?? "none"} runId={selectedRunId} />
    </main>
  );
}
