"use client";
import { Icon } from "@/components/ui/icon";

import React, { useMemo } from "react";
import type { QuestionIntegrityCheck, QuestionIntegrityStatus } from "@/lib/stellar/market-question";
import { analyzeTextSafety } from "@/lib/text-safety";

export interface QuestionVerificationBadgeProps {
  status: QuestionIntegrityStatus;
  result?: QuestionIntegrityCheck | null;
  compact?: boolean;
  className?: string;
  displayedText?: string | null;
}

export function QuestionVerificationBadge({
  status,
  result,
  compact = false,
  className = "",
  displayedText,
}: QuestionVerificationBadgeProps) {
  // If displayedText is provided or inside result.rawText, check for text safety findings
  const textToCheck = displayedText ?? result?.rawText;
  const safety = useMemo(() => analyzeTextSafety(textToCheck), [textToCheck]);

  if (status === "verified") {
    // If text has bidi or invisible characters, do NOT show an unqualified "verified"
    if (safety.hasBidiOrInvisible) {
      return (
        <span
          role="alert"
          title={`Verified hash, but text contains deceptive/hidden characters: ${safety.findings.map((f) => f.safeLabel).join(", ")}`}
          className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-error bg-error/15 px-2 py-0.5 rounded border border-error shrink-0 ${className}`}
        >
          <Icon name="warning" className="text-[13px]" />
          Verified, but contains hidden or deceptive characters
        </span>
      );
    }

    // Softer warning for confusables
    if (safety.hasConfusables) {
      return (
        <span
          title={`Verified hash, but contains mixed-script look-alike characters (${safety.findings.length} findings)`}
          className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-amber-600 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-600/30 shrink-0 ${className}`}
        >
          <Icon name="verified" filled className="text-[13px]" />
          Question Verified (confusable warnings)
        </span>
      );
    }

    return (
      <span
        title={`Verified: Text matches on-chain question_hash commitment (${result?.committedHash?.slice(0, 8)}…)`}
        className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-secondary bg-secondary/10 px-2 py-0.5 rounded border border-secondary/20 shrink-0 ${className}`}
      >
        <Icon name="verified" filled className="text-[13px]" />
        Question Verified
      </span>
    );
  }

  if (status === "mismatch") {
    return (
      <div
        role="alert"
        title={result?.reason ?? "Displayed question text differs from on-chain committed question"}
        className={`inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-error bg-error/15 px-2.5 py-1 rounded-md border border-error shadow-sm ${className}`}
      >
        <Icon name="error" className="text-[16px] animate-pulse" />
        <span>QUESTION MISMATCH: Do not trade without verifying chain!</span>
      </div>
    );
  }

  if (status === "unavailable") {
    if (compact) return null;
    return (
      <span
        title={result?.reason ?? "Question commitment could not be verified (IPFS unavailable)"}
        className={`inline-flex items-center gap-1 text-[10px] font-medium text-on-surface-variant bg-surface-container px-2 py-0.5 rounded border border-outline-variant/50 shrink-0 ${className}`}
      >
        <Icon name="cloud_off" className="text-[13px]" />
        Unverified
      </span>
    );
  }

  // not-committed
  if (compact) return null;
  return (
    <span
      title="This market was created without an on-chain question_hash commitment"
      className={`inline-flex items-center gap-1 text-[10px] font-medium text-on-surface-variant bg-surface-container px-2 py-0.5 rounded border border-outline-variant/50 shrink-0 ${className}`}
    >
      <Icon name="info" className="text-[13px]" />
      Not Committed
    </span>
  );
}
