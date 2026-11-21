"use client";
import React, { useState } from "react";
import { Icon } from "@/components/ui/icon";
import { analyzeTextSafety, type TextFinding } from "@/lib/text-safety";

export interface SafeTextProps {
  text: string | null | undefined;
  className?: string;
  as?: "span" | "p" | "div" | "h1" | "h2" | "h3";
  showToggle?: boolean;
  truncate?: number;
}

/**
 * SafeText component:
 * Renders plain text only (strictly avoids dangerouslySetInnerHTML).
 * Displays a visible warning marker with accessible tooltip/details when
 * bidi, invisible, control or confusable characters are detected.
 * Offers an escaped-view toggle for inspection.
 */
export function SafeText({
  text,
  className = "",
  as: Component = "span",
  showToggle = true,
  truncate,
}: SafeTextProps) {
  const [showEscaped, setShowEscaped] = useState(false);
  const analysis = analyzeTextSafety(text);

  if (!text) {
    return <Component className={className}>{""}</Component>;
  }

  const displayText = truncate ? analysis.safeTruncated(truncate) : text;
  const displayEscaped = truncate
    ? analyzeTextSafety(analysis.safeTruncated(truncate)).escapedView
    : analysis.escapedView;

  if (!analysis.hasFindings) {
    return <Component className={className}>{displayText}</Component>;
  }

  const warningLabel = analysis.hasBidiOrInvisible
    ? "Text contains hidden bidi controls, invisible characters, or control codes!"
    : "Text contains mixed-script look-alike (confusable) characters.";

  return (
    <Component className={`inline-flex flex-wrap items-center gap-1.5 ${className}`}>
      <span className={analysis.hasBidiOrInvisible ? "text-error font-medium" : ""}>
        {showEscaped ? displayEscaped : displayText}
      </span>

      {/* Warning marker badge */}
      <span
        role="alert"
        title={`${warningLabel} (${analysis.findings.length} findings)`}
        aria-label={warningLabel}
        className={`inline-flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.2 rounded border shrink-0 ${
          analysis.hasBidiOrInvisible
            ? "bg-error/15 text-error border-error"
            : "bg-surface-container-high text-on-surface-variant border-outline-variant"
        }`}
      >
        <Icon name="warning" className="text-[11px]" />
        <span>{analysis.hasBidiOrInvisible ? "Hidden chars" : "Confusables"}</span>
      </span>

      {/* Toggle escaped view button */}
      {showToggle && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setShowEscaped(!showEscaped);
          }}
          title={showEscaped ? "Show normal rendered view" : "Show escaped tokens (<U+...>) view"}
          className="text-[10px] underline font-data-mono text-primary hover:text-primary-focus shrink-0 ml-1"
        >
          {showEscaped ? "normal view" : "inspect <tokens>"}
        </button>
      )}
    </Component>
  );
}
