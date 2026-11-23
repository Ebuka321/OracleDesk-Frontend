"use client";

import React, { useEffect, useMemo, useState } from "react";
import { validateWatchAddress } from "@/lib/stellar/identity";
import {
  asPolicyCheckedAddress,
  classify,
  type AddressKind,
  type Finding,
  type KnownAddress,
  type PolicyCheckedAddress,
} from "@/lib/stellar/address-policy";
import { recordPolicyFinding } from "@/lib/diagnostics/events";
import { AddressText } from "@/components/ui/address-text";
import { LiveRegion } from "@/components/ui/live-region";
import { cn } from "@/lib/utils";

const ZERO_WIDTH_AND_WS = /[\s\u200B-\u200D\uFEFF\u00AD\u2060]/g;

export type AddressPolicy = "watch" | "authority" | "recipient";

export interface AddressInputProps {
  id?: string;
  value: string;
  onChange: (next: string) => void;
  onValidated?: (address: PolicyCheckedAddress | null) => void;
  policy: AddressPolicy;
  expect?: AddressKind | "any";
  known: readonly KnownAddress[];
  knownLoading?: boolean;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}

export function AddressInput({
  id,
  value,
  onChange,
  onValidated,
  policy,
  expect = "any",
  known,
  knownLoading = false,
  placeholder = "G… or C…",
  disabled = false,
  ariaLabel,
  className,
}: AddressInputProps) {
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  const [watchConfirmed, setWatchConfirmed] = useState(false);
  const [firstTimeConfirmed, setFirstTimeConfirmed] = useState(false);
  const [retypeSuffix, setRetypeSuffix] = useState("");

  // Reset per-candidate confirmations whenever the candidate string changes
  const trimmed = value.trim();
  const [lastCandidate, setLastCandidate] = useState(trimmed);
  if (trimmed !== lastCandidate) {
    setLastCandidate(trimmed);
    setWatchConfirmed(false);
    setFirstTimeConfirmed(false);
    setRetypeSuffix("");
  }

  const validation = useMemo(() => {
    if (!trimmed) return null;
    return validateWatchAddress(trimmed);
  }, [trimmed]);

  const findings: Finding[] = useMemo(() => {
    if (!validation || !validation.ok) return [];
    return classify(validation.address, known, { expect });
  }, [validation, known, expect]);

  const lookalike = findings.find(
    (f): f is Extract<Finding, { kind: "lookalike" }> => f.kind === "lookalike",
  );
  const wrongKind = findings.find(
    (f): f is Extract<Finding, { kind: "wrong-kind" }> => f.kind === "wrong-kind",
  );
  const isFirstTime = findings.some((f) => f.kind === "first-time");
  const knownMatch = findings.find(
    (f): f is Extract<Finding, { kind: "known" }> => f.kind === "known",
  );
  const isSelf = findings.some((f) => f.kind === "self");

  // Record diagnostics on non-trivial findings
  useEffect(() => {
    if (!validation?.ok || findings.length === 0) return;
    if (lookalike || wrongKind || isFirstTime) {
      recordPolicyFinding({
        policy,
        candidate: validation.address,
        findings: findings.map((f) =>
          f.kind === "lookalike"
            ? { kind: f.kind, of: f.of.address, prefix: f.prefix, suffix: f.suffix }
            : { kind: f.kind },
        ),
      });
    }
  }, [validation, findings, policy, lookalike, wrongKind, isFirstTime]);

  const expectedSuffix = validation?.ok ? validation.address.slice(-8) : "";

  const policySatisfied = useMemo(() => {
    if (!validation || !validation.ok) return false;
    if (wrongKind) return false;
    if (policy === "watch") {
      return !lookalike || watchConfirmed;
    }
    // authority and recipient
    if (knownLoading) return false;
    if (lookalike) {
      return retypeSuffix === expectedSuffix;
    }
    if (isFirstTime) {
      return firstTimeConfirmed;
    }
    return true;
  }, [
    validation,
    wrongKind,
    policy,
    lookalike,
    watchConfirmed,
    knownLoading,
    retypeSuffix,
    expectedSuffix,
    isFirstTime,
    firstTimeConfirmed,
  ]);

  useEffect(() => {
    if (!onValidated) return;
    if (validation?.ok && policySatisfied) {
      onValidated(asPolicyCheckedAddress(validation.address));
    } else {
      onValidated(null);
    }
  }, [onValidated, validation, policySatisfied]);

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const raw = e.clipboardData.getData("text");
    const cleaned = raw.replace(ZERO_WIDTH_AND_WS, "");
    if (cleaned !== raw) {
      e.preventDefault();
      const removedCount = raw.length - cleaned.length;
      setPasteNote(
        `Removed ${removedCount} whitespace or zero-width character${removedCount === 1 ? "" : "s"} on paste.`,
      );
      onChange(cleaned);
    } else {
      setPasteNote(null);
    }
  };

  const liveAnnouncement = lookalike
    ? `Warning: look-alike address matches ${lookalike.of.label} (${lookalike.prefix} prefix, ${lookalike.suffix} suffix). Verify the full address and identicon.`
    : wrongKind
      ? `Invalid address kind: expected ${wrongKind.expected}.`
      : null;

  return (
    <div className="space-y-2">
      <LiveRegion message={liveAnnouncement} politeness="assertive" />
      <input
        id={id}
        type="text"
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={Boolean(validation && !validation.ok) || Boolean(wrongKind)}
        placeholder={placeholder}
        onPaste={handlePaste}
        onChange={(e) => {
          setPasteNote(null);
          onChange(e.target.value);
        }}
        className={cn(
          "w-full bg-white border border-outline-variant rounded-lg px-3 py-2 text-xs font-data-mono outline-none focus:ring-2 focus:ring-primary",
          className,
        )}
      />

      {pasteNote && (
        <p className="text-[11px] text-on-surface-variant">{pasteNote}</p>
      )}

      {validation && !validation.ok && (
        <p role="alert" className="text-xs text-error">
          {validation.error}
        </p>
      )}

      {validation?.ok && (
        <div className="rounded-lg border border-outline-variant bg-surface-container-low p-3 space-y-2 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <AddressText address={validation.address} />
            {isSelf && (
              <span className="rounded bg-primary/10 text-primary px-2 py-0.5 text-[10px] font-bold uppercase">
                My Wallet
              </span>
            )}
            {knownMatch && (
              <span className="rounded bg-secondary/10 text-secondary px-2 py-0.5 text-[10px] font-bold uppercase">
                Known: {knownMatch.match.label}
              </span>
            )}
            {isFirstTime && !lookalike && (
              <span className="rounded bg-amber-500/15 text-amber-900 px-2 py-0.5 text-[10px] font-bold uppercase">
                First-time address
              </span>
            )}
          </div>

          {wrongKind && (
            <p role="alert" className="text-error font-medium">
              Expected a {wrongKind.expected === "account" ? "G… account" : "C… contract"} address.
            </p>
          )}

          {policy !== "watch" && knownLoading && (
            <p className="text-on-surface-variant font-medium">
              Comparison incomplete — loading known addresses…
            </p>
          )}

          {lookalike && (
            <div
              role="alert"
              className="rounded border border-error/40 bg-error-container/40 p-2.5 space-y-2 text-on-error-container"
            >
              <p className="font-bold">
                Look-alike warning ({lookalike.of.source === "self" ? "matches your own wallet" : `matches ${lookalike.of.label}`})
              </p>
              <p>
                Shares {lookalike.prefix} leading and {lookalike.suffix} trailing payload characters with{" "}
                <AddressText address={lookalike.of.address} compact />. Verify every chunk and the identicon.
              </p>
              {policy === "watch" ? (
                !watchConfirmed && (
                  <button
                    type="button"
                    onClick={() => setWatchConfirmed(true)}
                    className="rounded bg-error text-on-error px-3 py-1 text-[11px] font-bold"
                  >
                    Confirm look-alike
                  </button>
                )
              ) : (
                <div className="space-y-1">
                  <label htmlFor={`${id ?? "addr"}-retype`} className="block text-[11px] font-bold">
                    Re-type the last 8 characters to proceed:
                  </label>
                  <input
                    id={`${id ?? "addr"}-retype`}
                    type="text"
                    value={retypeSuffix}
                    onChange={(e) => setRetypeSuffix(e.target.value.trim())}
                    placeholder="Last 8 characters"
                    className="w-full rounded border border-error/40 bg-white px-2.5 py-1.5 font-data-mono text-xs text-on-surface"
                  />
                </div>
              )}
            </div>
          )}

          {policy !== "watch" && !lookalike && isFirstTime && !wrongKind && !knownLoading && (
            <label className="flex items-start gap-2 cursor-pointer pt-1">
              <input
                type="checkbox"
                checked={firstTimeConfirmed}
                onChange={(e) => setFirstTimeConfirmed(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                I have verified the full chunked address and identicon for this first-time{" "}
                {policy === "authority" ? "authority" : "recipient"}.
              </span>
            </label>
          )}
        </div>
      )}
    </div>
  );
}
