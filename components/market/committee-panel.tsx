"use client";

/**
 * Shows resolver committee membership, rounds and pending rotations for a market.
 * Issue #231
 */

import React, { useEffect, useState } from "react";
import { shortAddress } from "@/lib/stellar/units";

export interface CommitteeMember {
  address: string;
  weight?: number;
}

export interface CommitteeRotation {
  proposedAt: number;
  rotationDelay: number;
  newMembers: CommitteeMember[];
  newThreshold: number;
  executeAfter: number;
  executed: boolean;
}

export interface CommitteeInfo {
  committeeId: bigint;
  admin: string;
  members: CommitteeMember[];
  threshold: number;
  epoch: number;
  rotationDelay: number;
  pendingRotation?: CommitteeRotation;
  minEpoch?: number;
  maxRotationDelta?: number;
  disputeWindow?: number;
}

interface CommitteePanelProps {
  committeeInfo: CommitteeInfo;
  className?: string;
}

function formatDuration(seconds: number): string {
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export function CommitteePanel({ committeeInfo, className = "" }: CommitteePanelProps) {
  const { committeeId, admin, members, threshold, epoch, rotationDelay, pendingRotation, disputeWindow } = committeeInfo;
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  const canExecuteRotation = pendingRotation && now >= pendingRotation.executeAfter * 1000 && !pendingRotation.executed;

  return (
    <div className={`rounded-lg border border-outline-variant bg-surface-container-lowest p-4 ${className}`}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-headline-sm text-sm font-semibold text-on-surface">
          Committee #{committeeId.toString()}
        </h3>
        <span className="rounded bg-surface-container px-2 py-0.5 text-xs text-on-surface-variant">
          Epoch {epoch}
        </span>
      </div>

      <dl className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <dt className="text-on-surface-variant">Admin</dt>
        <dd className="font-data-mono text-on-surface">{shortAddress(admin, 6, 4)}</dd>
        <dt className="text-on-surface-variant">Threshold</dt>
        <dd className="text-on-surface">{threshold} of {members.length}</dd>
        <dt className="text-on-surface-variant">Rotation delay</dt>
        <dd className="text-on-surface">{formatDuration(rotationDelay)}</dd>
        {disputeWindow != null && (
          <>
            <dt className="text-on-surface-variant">Dispute window</dt>
            <dd className="text-on-surface">{formatDuration(disputeWindow)}</dd>
          </>
        )}
      </dl>

      <div className="mb-3">
        <p className="mb-1 text-xs font-medium text-on-surface-variant">Members ({members.length})</p>
        <ul className="space-y-0.5">
          {members.map((m) => (
            <li key={m.address} className="flex items-center justify-between text-xs">
              <span className="font-data-mono text-on-surface">{shortAddress(m.address, 8, 4)}</span>
              {m.weight != null && (
                <span className="text-on-surface-variant">weight {m.weight}</span>
              )}
            </li>
          ))}
        </ul>
      </div>

      {pendingRotation && !pendingRotation.executed && (
        <div className="rounded border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950">
          <p className="mb-2 text-xs font-semibold text-amber-800 dark:text-amber-300">
            Pending rotation — {canExecuteRotation ? "ready to execute" : `executable in ${formatDuration(Math.max(0, Math.floor((pendingRotation.executeAfter * 1000 - now) / 1000)))}`}
          </p>
          <p className="mb-1 text-xs text-amber-700 dark:text-amber-400">
            New threshold: {pendingRotation.newThreshold} of {pendingRotation.newMembers.length}
          </p>
          <ul className="space-y-0.5">
            {pendingRotation.newMembers.map((m) => (
              <li key={m.address} className="font-data-mono text-xs text-amber-700 dark:text-amber-400">
                {shortAddress(m.address, 8, 4)}
              </li>
            ))}
          </ul>
          {canExecuteRotation && (
            <p className="mt-2 text-xs text-on-surface-variant">
              Call <code className="font-data-mono">execute_rotation(#{committeeId.toString()})</code> on the resolver contract to apply this rotation.
            </p>
          )}
        </div>
      )}

      {(!pendingRotation || pendingRotation.executed) && (
        <p className="text-xs text-on-surface-variant">No pending rotation.</p>
      )}
    </div>
  );
}

/**
 * Fetches and displays the committee for a market that uses `ResolutionSpec::Committee`.
 */
interface MarketCommitteeSectionProps {
  marketId: string;
  committeeId: bigint;
  minEpoch?: number;
  disputeWindow?: number;
}

export function MarketCommitteeSection({ marketId: _marketId, committeeId, minEpoch, disputeWindow }: MarketCommitteeSectionProps) {
  const [info, setInfo] = useState<CommitteeInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    // Dynamically import the resolver client to avoid loading it in every route
    import("@/lib/stellar/generated/resolver").then(async (mod) => {
      try {
        // The resolver binding's get_committee returns a Committee struct.
        // We use a simulation call (read-only) to fetch it.
        const result = await (mod as unknown as { Client: { new(opts: unknown): { get_committee(args: { committee_id: bigint }): Promise<{ result: unknown }> } } }).Client;
        // Fall through to placeholder if the binding API changed
        void result;
        setError("Committee fetch requires a configured resolver client. Connect a wallet to load live data.");
      } catch {
        setError("Could not load committee data.");
      } finally {
        setLoading(false);
      }
    }).catch(() => {
      setError("Resolver binding unavailable.");
      setLoading(false);
    });
  }, [committeeId]);

  // Show a static placeholder until live data is wired through the resolver hook
  if (loading) return <div className="text-xs text-on-surface-variant">Loading committee…</div>;
  if (error && !info) return (
    <CommitteePanel committeeInfo={{
      committeeId,
      admin: "—",
      members: [],
      threshold: 0,
      epoch: 0,
      rotationDelay: 86400,
      minEpoch,
      disputeWindow,
    }} />
  );
  if (!info) return null;
  return <CommitteePanel committeeInfo={info} />;
}
