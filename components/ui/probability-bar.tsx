import React from "react";

export interface ProbabilityBarProps {
  /** YES probability percentage (0 to 100). */
  yes: number;
  /** NO probability percentage (0 to 100). Defaults to 100 - yes. */
  no?: number;
  /** Height class for the bar (default: "h-2"). */
  heightClassName?: string;
  /** Custom container class. */
  className?: string;
}

/**
 * Accessible probability bar with support for high contrast forced-colors.
 * In forced-colors mode, YES renders solid CanvasText while NO renders hatched.
 */
export function ProbabilityBar({
  yes,
  no = 100 - yes,
  heightClassName = "h-2",
  className = "",
}: ProbabilityBarProps) {
  const safeYes = Number.isFinite(yes) ? Math.max(0, Math.min(100, Math.round(yes))) : 50;
  const safeNo = Number.isFinite(no) ? Math.max(0, Math.min(100, Math.round(no))) : 100 - safeYes;

  const total = safeYes + safeNo;
  const yesWidth = total > 0 ? (safeYes / total) * 100 : 50;
  const noWidth = total > 0 ? 100 - yesWidth : 50;

  return (
    <div
      role="img"
      aria-label={`YES ${safeYes}%, NO ${safeNo}%`}
      className={`w-full ${heightClassName} rounded-full bg-surface-container overflow-hidden flex ${className}`}
    >
      <div
        data-prob-seg="yes"
        className="probability-yes h-full bg-secondary transition-all duration-500"
        style={{ width: `${yesWidth}%` }}
      />
      {safeYes > 0 && safeNo > 0 && (
        <div className="w-[1px] h-full bg-surface shrink-0" aria-hidden="true" />
      )}
      <div
        data-prob-seg="no"
        className="probability-no h-full bg-tertiary transition-all duration-500"
        style={{ width: `${noWidth}%` }}
      />
    </div>
  );
}
