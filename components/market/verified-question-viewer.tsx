"use client";

import React, { useState } from "react";
import { Icon } from "@/components/ui/icon";
import type { QuestionIntegrityCheck } from "@/lib/stellar/market-question";

export interface VerifiedQuestionViewerProps {
  check?: QuestionIntegrityCheck | null;
  className?: string;
}

const MAX_QUESTION_CHARS = 240;
const MAX_INSTRUCTIONS_CHARS = 300;

export function VerifiedQuestionViewer({ check, className = "" }: VerifiedQuestionViewerProps) {
  const [questionExpanded, setQuestionExpanded] = useState(false);
  const [instructionsExpanded, setInstructionsExpanded] = useState(false);

  if (!check) return null;

  const doc = check.parsedDoc;
  const isVerified = check.status === "verified";
  const questionText = check.committedQuestion ?? check.displayedQuestion;
  const isLongQuestion = questionText.length > MAX_QUESTION_CHARS;
  const displayedQuestionSnippet = !questionExpanded && isLongQuestion
    ? `${questionText.slice(0, MAX_QUESTION_CHARS)}…`
    : questionText;

  const mismatches = check.mismatches;
  const hasMismatches = mismatches && Object.keys(mismatches).length > 0;

  return (
    <div className={`space-y-4 rounded-xl border border-outline-variant/60 bg-surface-container-low p-4 sm:p-5 ${className}`}>
      {/* Verified Header & Badge */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-outline-variant/40 pb-3">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-bold uppercase tracking-wider ${
              isVerified
                ? "bg-secondary/10 text-secondary border border-secondary/20"
                : check.status === "mismatch"
                ? "bg-error/15 text-error border border-error/30"
                : "bg-surface-container-highest text-on-surface-variant border border-outline-variant/40"
            }`}
          >
            <Icon
              name={isVerified ? "verified" : check.status === "mismatch" ? "error" : "info"}
              filled={isVerified}
              className="text-[14px]"
            />
            {isVerified ? "On-Chain Verified Document" : check.status === "mismatch" ? "Integrity Mismatch" : "Unverified Question"}
          </span>
          {doc && (
            <span className="text-[11px] font-data-mono text-on-surface-variant uppercase">
              Schema {doc.schemaType}
            </span>
          )}
        </div>

        {check.committedHash && (
          <span className="font-data-mono text-[11px] text-on-surface-variant" title={check.committedHash}>
            Hash: {check.committedHash.slice(0, 10)}…{check.committedHash.slice(-8)}
          </span>
        )}
      </div>

      {/* Cross-Check Warnings / Disagreements */}
      {hasMismatches && (
        <div role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 space-y-2 text-xs">
          <div className="flex items-center gap-1.5 font-bold text-amber-700 dark:text-amber-400 uppercase tracking-wide">
            <Icon name="warning" className="text-[15px]" />
            <span>State Disagreement Notice</span>
          </div>

          {mismatches.questionMismatch && (
            <div className="space-y-1">
              <p className="text-on-surface-variant">
                <span className="font-semibold text-amber-700 dark:text-amber-400">Question title differs:</span> The backend displays &ldquo;{mismatches.questionMismatch.displayed}&rdquo;. The on-chain committed text below is authoritative.
              </p>
            </div>
          )}

          {mismatches.closeTimeMismatch && (
            <p className="text-on-surface-variant">
              <span className="font-semibold text-amber-700 dark:text-amber-400">Close time mismatch:</span> Contract close time ({new Date(mismatches.closeTimeMismatch.chain * 1000).toISOString()}) differs from document close time ({new Date(mismatches.closeTimeMismatch.doc * 1000).toISOString()}).
            </p>
          )}

          {mismatches.categoryMismatch && (
            <p className="text-on-surface-variant">
              <span className="font-semibold text-amber-700 dark:text-amber-400">Category mismatch:</span> On-chain category ({mismatches.categoryMismatch.chain}) does not match document ({mismatches.categoryMismatch.doc}).
            </p>
          )}

          {mismatches.resolutionHashMismatch && (
            <p className="text-on-surface-variant">
              <span className="font-semibold text-amber-700 dark:text-amber-400">Resolution hash mismatch:</span> Contract commits to {mismatches.resolutionHashMismatch.chain.slice(0, 12)}… while document specifies {mismatches.resolutionHashMismatch.doc.slice(0, 12)}….
            </p>
          )}
        </div>
      )}

      {/* Verified Question Text (Plain text only) */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-label-caps text-on-surface-variant uppercase font-bold tracking-wider">
            Authoritative Question Text
          </span>
          {mismatches?.questionMismatch && (
            <span className="text-[10px] font-bold uppercase text-secondary bg-secondary/10 px-1.5 py-0.5 rounded">
              Verified Text Wins
            </span>
          )}
        </div>
        <p className="font-body-md text-on-surface whitespace-pre-wrap break-words text-sm sm:text-base leading-relaxed">
          {displayedQuestionSnippet}
        </p>
        {isLongQuestion && (
          <button
            type="button"
            onClick={() => setQuestionExpanded((prev) => !prev)}
            className="text-xs text-primary font-semibold hover:underline inline-flex items-center gap-1 mt-1 cursor-pointer"
          >
            {questionExpanded ? "Show less" : "Show full question"}
          </button>
        )}
      </div>

      {/* Resolution Terms Block */}
      {doc?.resolution ? (
        <div className="rounded-lg border border-outline-variant/50 bg-surface p-4 space-y-3">
          <div className="flex items-center justify-between border-b border-outline-variant/30 pb-2">
            <h4 className="font-label-caps text-label-caps text-on-surface font-bold uppercase tracking-wider flex items-center gap-1.5">
              <Icon name="rule" className="text-[15px] text-primary" />
              Resolution Criteria & Terms
            </h4>
            <span className="text-[11px] font-data-mono text-on-surface-variant">
              Source: {doc.resolution.sourceId}
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div>
              <span className="text-on-surface-variant uppercase font-medium text-[10px]">Measurable</span>
              <p className="font-medium text-on-surface mt-0.5">{doc.resolution.measurable}</p>
            </div>

            <div>
              <span className="text-on-surface-variant uppercase font-medium text-[10px]">Criterion</span>
              <p className="font-data-mono text-on-surface mt-0.5 font-bold">
                {doc.resolution.comparator} {doc.resolution.threshold}
              </p>
            </div>

            <div>
              <span className="text-on-surface-variant uppercase font-medium text-[10px]">Deadline UTC</span>
              <p className="font-data-mono text-on-surface mt-0.5">{doc.resolution.deadlineUtc}</p>
            </div>

            {doc.resolution.safeUrl && (
              <div>
                <span className="text-on-surface-variant uppercase font-medium text-[10px]">Resolution URL</span>
                <p className="mt-0.5">
                  <a
                    href={doc.resolution.safeUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline font-data-mono inline-flex items-center gap-1"
                  >
                    <span>{doc.resolution.urlHost || "External Source"}</span>
                    <Icon name="open_in_new" className="text-[12px]" />
                  </a>
                </p>
              </div>
            )}
          </div>

          {/* Instructions Expander */}
          {doc.resolution.instructions && (
            <div className="border-t border-outline-variant/30 pt-2 text-xs">
              <span className="text-on-surface-variant uppercase font-medium text-[10px]">Resolution Instructions</span>
              <p className="font-body-sm text-on-surface mt-1 whitespace-pre-wrap break-words text-xs leading-normal">
                {!instructionsExpanded && doc.resolution.instructions.length > MAX_INSTRUCTIONS_CHARS
                  ? `${doc.resolution.instructions.slice(0, MAX_INSTRUCTIONS_CHARS)}…`
                  : doc.resolution.instructions}
              </p>
              {doc.resolution.instructions.length > MAX_INSTRUCTIONS_CHARS && (
                <button
                  type="button"
                  onClick={() => setInstructionsExpanded((prev) => !prev)}
                  className="text-[11px] text-primary font-semibold hover:underline inline-flex items-center gap-1 mt-1 cursor-pointer"
                >
                  {instructionsExpanded ? "Show less" : "Show full instructions"}
                </button>
              )}
            </div>
          )}
        </div>
      ) : doc?.isPlainText ? (
        <div className="rounded-lg border border-outline-variant/40 bg-surface/60 p-3 text-xs text-on-surface-variant flex items-center gap-2">
          <Icon name="info" className="text-[16px] text-outline shrink-0" />
          <span>
            Plain-text question document: No structured resolution terms committed on-chain.
          </span>
        </div>
      ) : (
        <div className="rounded-lg border border-outline-variant/40 bg-surface/60 p-3 text-xs text-on-surface-variant flex items-center gap-2">
          <Icon name="info" className="text-[16px] text-outline shrink-0" />
          <span>No structured resolution terms block included in this question document.</span>
        </div>
      )}

      {/* Price Resolution Fields if present */}
      {doc?.priceResolution && (
        <div className="rounded-lg border border-outline-variant/40 bg-surface p-3 text-xs space-y-1">
          <span className="text-[10px] uppercase font-bold text-on-surface-variant tracking-wider">
            Price Oracle Resolution Parameters
          </span>
          <div className="font-data-mono text-xs text-on-surface grid grid-cols-2 gap-2">
            {doc.priceResolution.oracle && <div>Oracle: {String(doc.priceResolution.oracle)}</div>}
            {doc.priceResolution.asset && <div>Asset: {String(doc.priceResolution.asset)}</div>}
            {doc.priceResolution.threshold && <div>Threshold: {String(doc.priceResolution.threshold)}</div>}
            {doc.priceResolution.comparison && <div>Comparison: {String(doc.priceResolution.comparison)}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
