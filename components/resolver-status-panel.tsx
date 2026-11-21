"use client";
import { Icon } from "@/components/ui/icon";

import React, { useEffect, useState } from "react";
import type { ResolutionSpec } from "@/lib/api/markets";
import {
  formatResolutionSpec,
  verifyResolutionCommitment,
  type ResolutionVerificationResult,
} from "@/lib/stellar/resolution-spec";
import { ResolutionDeadlineCard } from "@/components/market/resolution-deadline-card";

const SourceTag = ({ source }: { source: "chain" | "backend" }) => (
  <span
    title={source === "chain" ? "Read live from the market contract" : "OracleDesk backend estimate; may lag the chain"}
    className={`ms-1 text-[9px] font-bold uppercase px-1 rounded ${
      source === "chain"
        ? "bg-secondary-container text-on-secondary-container"
        : "bg-surface-container-highest text-on-surface-variant"
    }`}
  >
    {source}
  </span>
);

export interface ResolverStatusPanelProps {
  onChainMarketId?: bigint | string | null;
  resolverState?:
    | "Unconfigured"
    | "SignersPending"
    | "Finalized"
    | "Expired"
    | "Disputed"
    | "HybridPricePending"
    | "HybridFallbackOpen"
    | string;
  marketStatus?: string;
  resolutionHash?: Buffer | Uint8Array | string | null;
  resolutionSpec?: ResolutionSpec | null;
  /**
   * The resolution_hash committed on-chain in the market-core/resolver contract.
   */
  resolutionHash?: Buffer | Uint8Array | string | null;
  /**
   * Optional market status from market-core (e.g. "Active", "Resolving", "Resolved").
   */
  marketStatus?: string;
  className?: string;
}

export function ResolverStatusPanel({
  onChainMarketId,
  resolverState = "Unconfigured",
  marketStatus,
  resolutionHash,
  resolutionSpec,
  resolutionHash,
  marketStatus,
  className = "",
}: ResolverStatusPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [verification, setVerification] = useState<ResolutionVerificationResult | null>(null);

  useEffect(() => {
    void verifyResolutionCommitment(resolutionSpec, resolutionHash).then((res) => {
      setVerification(res);
    });
  }, [resolutionSpec, resolutionHash]);

  const hashString = formatHashHex(resolutionHash);
  const formattedWords = formatResolutionSpec(resolutionSpec);

  return (
    <div
      className={`border border-outline-variant rounded-xl overflow-hidden bg-surface-container-lowest transition-all ${className}`}
    >
      {/* Header bar / Summary Toggle */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full p-4 flex items-center justify-between bg-surface-container-low hover:bg-surface-container transition-colors text-start"
      >
        <div className="flex items-center gap-2">
          <Icon name="policy" className="text-primary text-base" />
          <h3 className="font-headline-sm text-headline-sm text-on-surface">Market Resolution & Commitment</h3>
          {verification?.status === "verified" && (
            <span className="ms-2 inline-flex items-center gap-1 text-[10px] font-bold text-secondary bg-secondary/10 px-2 py-0.5 rounded border border-secondary/20">
              <Icon name="verified" filled className="text-[13px]" />
              Commitment Verified
            </span>
          )}
          {verification?.status === "mismatch" && (
            <span className="ms-2 inline-flex items-center gap-1 text-[10px] font-bold text-error bg-error/15 px-2 py-0.5 rounded border border-error animate-pulse">
              <Icon name="error" className="text-[13px]" />
              Spec Hash Mismatch
            </span>
          )}
        </div>

        <Icon name={isOpen ? "expand_less" : "expand_more"} className="text-on-surface-variant text-sm" />
      </button>

      {/* Panel Content */}
      {isOpen && (
        <div className="p-5 space-y-4 border-t border-outline-variant bg-surface">
          {/* Status Row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="p-3 bg-surface-container-low rounded-lg border border-outline-variant/60">
              <span className="font-label-caps text-label-caps text-on-surface-variant block mb-1">
                RESOLVER STATE <SourceTag source="chain" />
              </span>
              <span className="font-data-mono text-body-md text-on-surface font-semibold">
                {resolverState}
              </span>
            </div>

            {marketStatus && (
              <div className="p-3 bg-surface-container-low rounded-lg border border-outline-variant/60">
                <span className="font-label-caps text-label-caps text-on-surface-variant block mb-1">
                  MARKET-CORE STATUS <SourceTag source="chain" />
                </span>
                <span className="font-data-mono text-body-md text-on-surface font-semibold">
                  {marketStatus}
                </span>
              </div>
            )}
          </div>

          <ResolutionDeadlineCard onChainMarketId={onChainMarketId} />

          {/* Revealed Spec in Plain Words */}
          <div className="p-4 bg-surface-container-lowest rounded-lg border border-outline-variant">
            <div className="flex items-center justify-between mb-2">
              <span className="font-label-caps text-label-caps text-on-surface-variant uppercase">
                REVEALED RESOLUTION SPEC <SourceTag source="backend" />
              </span>
              {verification?.status === "verified" ? (
                <span className="text-[11px] font-bold text-secondary flex items-center gap-1">
                  <Icon name="check_circle" filled className="text-xs" />
                  Matches on-chain commitment
                </span>
              ) : verification?.status === "mismatch" ? (
                <span className="text-[11px] font-bold text-error flex items-center gap-1">
                  <Icon name="error" className="text-xs" />
                  Hash mismatch (do not trust!)
                </span>
              ) : verification?.status === "unsupported" ? (
                <span className="text-[11px] font-medium text-on-surface-variant flex items-center gap-1">
                  <Icon name="help_outline" className="text-xs" />
                  Rule kind not evaluated
                </span>
              ) : null}
            </div>

            {resolutionSpec ? (
              <p className="font-body-md text-on-surface font-medium leading-relaxed">
                {formattedWords}
              </p>
            ) : (
              <p className="text-sm text-on-surface-variant italic">
                A market without a revealed spec has not yet disclosed its resolution rule on-chain.
              </p>
            )}
          </div>

          {/* Commitment Hash Verification Details */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="p-3 bg-surface-container-low rounded-lg border border-outline-variant/60">
              <span className="font-label-caps text-label-caps text-on-surface-variant block mb-1">
                COMMITTED HASH (ON-CHAIN) <SourceTag source="chain" />
              </span>
              <code className="text-xs break-all font-data-mono text-on-surface block">
                {hashString ? hashString : "No commitment hash on-chain"}
              </code>
            </div>

            <div className="p-3 bg-surface-container-low rounded-lg border border-outline-variant/60">
              <span className="font-label-caps text-label-caps text-on-surface-variant block mb-1">
                RECOMPUTED SPEC HASH (LOCAL)
              </span>
              <code
                className={`text-xs break-all font-data-mono block ${
                  verification?.status === "verified"
                    ? "text-secondary font-bold"
                    : verification?.status === "mismatch"
                      ? "text-error font-bold"
                      : "text-on-surface-variant"
                }`}
              >
                {verification?.computedHash ?? (
                  verification?.status === "unsupported"
                    ? "N/A (unsupported kind)"
                    : resolutionSpec
                      ? "Computing…"
                      : "No revealed spec to hash"
                )}
              </code>
            </div>
          </div>

          {/* Strong Warning on Mismatch */}
          {verification?.status === "mismatch" && (
            <div
              role="alert"
              className="p-3 bg-error-container/20 border border-error rounded-lg text-error text-xs flex items-center gap-2"
            >
              <Icon name="error" className="text-base" />
              <div>
                <span className="font-bold">CRITICAL WARNING: </span>
                The backend&apos;s displayed resolution spec does not hash to the on-chain commitment hash.
                The market may settle according to different rules!
              </div>
            </div>
          )}

          {/* Non-alarming Info on Unsupported */}
          {verification?.status === "unsupported" && (
            <div
              role="note"
              className="p-3 bg-surface-container border border-outline-variant rounded-lg text-on-surface-variant text-xs flex items-center gap-2"
            >
              <Icon name="info" className="text-base text-on-surface-variant" />
              <div>
                <span className="font-semibold text-on-surface">Notice: </span>
                This market uses an advanced resolver rule ({resolutionSpec?.kind}). The client cannot independently verify this commitment format, so no claim is made either way.
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SourceTag({ source }: { source: "chain" | "backend" }) {
  return (
    <span
      className={`text-[9px] px-1.5 py-0.2 rounded font-bold uppercase tracking-wider ml-1 ${
        source === "chain"
          ? "bg-secondary/15 text-secondary"
          : "bg-surface-container-high text-on-surface-variant"
      }`}
    >
      {source}
    </span>
  );
}
