"use client";

import React, { useState, useEffect } from "react";
import { Icon } from "@/components/ui/icon";
import { useWallet } from "@/lib/contexts/WalletContext";
import { isAdminAddress, NETWORK_LABEL, NETWORK_PASSPHRASE, TESTNET_PASSPHRASE } from "@/lib/stellar/config";
import { formatUsdc } from "@/lib/stellar/units";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  type TreasuryOpKind,
  type TreasuryOperationIntent,
  verifyTreasuryOperation,
  verifySignedEnvelopeMatches,
  type DecodedTreasuryOp,
} from "@/lib/stellar/treasury-decoder";
import {
  type TreasuryOperationRecord,
  type PreflightCheck,
  calculateCollectedWeight,
  isOperationReady,
  prepareTreasuryOperation,
  uploadTreasurySignature,
  submitTreasuryOperation,
  cancelTreasuryOperation,
} from "@/lib/api/treasury-admin";
import { signInWithWallet } from "@/lib/api/auth";
import { ApiError } from "@/lib/api/client";

export function TreasuryConsole() {
  const { address, signTransaction } = useWallet();
  const [selectedKind, setSelectedKind] = useState<TreasuryOpKind>("treasury.withdraw");

  // Form Inputs (Raw amounts, no floating point arithmetic)
  const [targetAddress, setTargetAddress] = useState("");
  const [amountRawInput, setAmountRawInput] = useState("");
  const [pausedState, setPausedState] = useState(true);
  const [marketIdsInput, setMarketIdsInput] = useState("");

  // Operation state
  const [operation, setOperation] = useState<TreasuryOperationRecord | null>(null);
  const [decodedOp, setDecodedOp] = useState<DecodedTreasuryOp | null>(null);
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSigning, setIsSigning] = useState(false);

  // Preflight failed & Force confirmation state
  const [showForceConfirm, setShowForceConfirm] = useState(false);
  const [failingChecks, setFailingChecks] = useState<PreflightCheck[]>([]);

  // Expiry countdown
  const [secondsRemaining, setSecondsRemaining] = useState<number | null>(null);

  const isTestnet = NETWORK_PASSPHRASE === TESTNET_PASSPHRASE;
  const isAuthorized = isAdminAddress(address);

  // Countdown timer for prepared operation
  useEffect(() => {
    if (!operation || !operation.validUntil) {
      setSecondsRemaining(null);
      return;
    }
    const update = () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const remaining = Math.max(0, operation.validUntil - nowSec);
      setSecondsRemaining(remaining);
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [operation]);

  // Build intent from form inputs
  const buildIntent = (): TreasuryOperationIntent | null => {
    if (!address) return null;
    try {
      switch (selectedKind) {
        case "treasury.set_paused":
          return { kind: "treasury.set_paused", paused: pausedState, adminAddress: address };
        case "treasury.withdraw": {
          const raw = BigInt(amountRawInput || "0");
          if (raw <= 0n) throw new Error("Amount must be greater than zero");
          return { kind: "treasury.withdraw", recipient: targetAddress.trim(), amountRaw: raw, adminAddress: address };
        }
        case "treasury.deposit": {
          const raw = BigInt(amountRawInput || "0");
          if (raw <= 0n) throw new Error("Amount must be greater than zero");
          return { kind: "treasury.deposit", from: address, amountRaw: raw };
        }
        case "treasury.collect_market_fees": {
          const ids = marketIdsInput
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .map((s) => BigInt(s));
          if (ids.length === 0) throw new Error("At least one market ID is required");
          return { kind: "treasury.collect_market_fees", marketIds: ids, adminAddress: address };
        }
        case "market_core.set_paused":
          return { kind: "market_core.set_paused", paused: pausedState, adminAddress: address };
      }
    } catch {
      return null;
    }
  };

  const handlePrepare = async (force = false) => {
    setStatusMessage(null);
    setVerificationError(null);
    const intent = buildIntent();
    if (!intent) {
      setStatusMessage("Please check and complete all required inputs with valid values.");
      return;
    }

    setIsSubmitting(true);
    try {
      const record = await prepareTreasuryOperation({
        kind: selectedKind,
        params: intent as unknown as Record<string, unknown>,
        force,
      });

      // Crucial: Client verifies the prepared XDR independently
      const check = verifyTreasuryOperation(record.xdr, intent, record.hash);
      if (!check.valid) {
        setVerificationError(check.reason ?? "Prepared XDR verification failed");
        setDecodedOp(null);
      } else {
        setDecodedOp(check.decoded ?? null);
        setVerificationError(null);
      }

      setOperation(record);
      setShowForceConfirm(false);
    } catch (err) {
      if (err instanceof ApiError && err.code === "PREFLIGHT_FAILED") {
        const checks = (err.details as { checks?: PreflightCheck[] })?.checks ?? [];
        setFailingChecks(checks.filter((c) => !c.passed));
        setShowForceConfirm(true);
      } else if (err instanceof ApiError && (err.code === "STEP_UP_REQUIRED" || err.status === 401)) {
        setStatusMessage("Step-up authentication required. Re-authenticating with wallet...");
        if (address && signTransaction) {
          try {
            await signInWithWallet(address, signTransaction);
            setStatusMessage("Re-authentication succeeded. Retrying preparation...");
            return handlePrepare(force);
          } catch {
            setStatusMessage("Re-authentication failed. Please try again.");
          }
        }
      } else {
        setStatusMessage(err instanceof Error ? err.message : "Failed to prepare operation");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSign = async () => {
    if (!operation || !signTransaction || !address) return;
    setIsSigning(true);
    setStatusMessage(null);

    try {
      // 1. Sign through wallet interface
      const signedXdr = await signTransaction(operation.xdr, operation.networkPassphrase);

      // 2. Client re-verifies signed envelope: exact same transaction body and hash
      const check = verifySignedEnvelopeMatches(operation.xdr, signedXdr, operation.networkPassphrase);
      if (!check.valid) {
        throw new Error(`Signature rejected: ${check.reason}`);
      }

      // 3. Upload verified signed XDR
      const updated = await uploadTreasurySignature(operation.id, signedXdr);
      setOperation(updated);
      setStatusMessage("Signature successfully recorded!");
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : "Failed to sign operation");
    } finally {
      setIsSigning(false);
    }
  };

  const handleSubmit = async () => {
    if (!operation) return;
    if (!isTestnet) {
      setStatusMessage("TESTNET_ONLY: Submitting treasury operations is restricted to Stellar Testnet.");
      return;
    }

    setIsSubmitting(true);
    setStatusMessage(null);
    try {
      const res = await submitTreasuryOperation(operation.id);
      setOperation(res.operation);
      setStatusMessage(`Transaction submitted successfully! Hash: ${res.txHash}`);
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : "Submission failed");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancel = async () => {
    if (!operation) return;
    setIsSubmitting(true);
    try {
      const res = await cancelTreasuryOperation(operation.id);
      setOperation(res);
      setStatusMessage("Operation cancelled.");
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : "Failed to cancel operation");
    } finally {
      setIsSubmitting(false);
    }
  };

  const collectedWeight = operation ? calculateCollectedWeight(operation.signatures, operation.requiredSigners) : 0;
  const isReady = operation ? isOperationReady(operation) : false;
  const isExpired = secondsRemaining === 0;

  return (
    <div className="space-y-8">
      {/* Network & Authority Notice */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-xl border border-outline-variant bg-surface-container-low">
        <div className="flex items-center gap-2">
          <Icon name="verified_user" className="text-primary text-[20px]" />
          <div>
            <h3 className="text-sm font-bold uppercase tracking-wider text-on-surface">
              Treasury Operations Console
            </h3>
            <p className="text-xs text-on-surface-variant">
              Multi-signer privileged contract administration ({NETWORK_LABEL}).
            </p>
          </div>
        </div>
        {!isTestnet && (
          <span className="px-2.5 py-1 rounded bg-error/15 text-error text-xs font-bold uppercase tracking-wider border border-error/30">
            TESTNET ONLY ENFORCED
          </span>
        )}
      </div>

      {/* Operation Input Form */}
      <div className="p-6 rounded-xl border border-outline-variant bg-surface space-y-6">
        <div className="space-y-1 border-b border-outline-variant/40 pb-4">
          <h2 className="font-headline-sm text-headline-sm text-on-surface">1. Select & Configure Operation</h2>
          <p className="text-xs text-on-surface-variant">
            Input parameters are independently decoded and checked against the prepared XDR before signing.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-2">
            <label className="text-xs font-bold uppercase text-on-surface-variant">Operation Kind</label>
            <select
              value={selectedKind}
              onChange={(e) => {
                setSelectedKind(e.target.value as TreasuryOpKind);
                setOperation(null);
                setDecodedOp(null);
              }}
              className="w-full bg-surface-container border border-outline px-3 py-2 rounded-lg text-sm font-data-mono"
            >
              <option value="treasury.withdraw">treasury.withdraw (Withdraw Collateral)</option>
              <option value="treasury.deposit">treasury.deposit (Fund Treasury)</option>
              <option value="treasury.set_paused">treasury.set_paused (Pause Treasury)</option>
              <option value="treasury.collect_market_fees">treasury.collect_market_fees (Collect Fees)</option>
              <option value="market_core.set_paused">market_core.set_paused (Pause Market Core)</option>
            </select>
          </div>

          {(selectedKind === "treasury.withdraw" || selectedKind === "treasury.deposit") && (
            <>
              {selectedKind === "treasury.withdraw" && (
                <div className="space-y-2">
                  <label className="text-xs font-bold uppercase text-on-surface-variant">Recipient (G-Address)</label>
                  <input
                    type="text"
                    value={targetAddress}
                    onChange={(e) => setTargetAddress(e.target.value)}
                    placeholder="G..."
                    className="w-full bg-surface-container border border-outline px-3 py-2 rounded-lg text-sm font-data-mono"
                  />
                </div>
              )}
              <div className="space-y-2">
                <label className="text-xs font-bold uppercase text-on-surface-variant">Raw Amount (7 Decimals BigInt)</label>
                <input
                  type="text"
                  value={amountRawInput}
                  onChange={(e) => setAmountRawInput(e.target.value.replace(/[^0-9]/g, ""))}
                  placeholder="e.g. 10000000 for 1.0000000 USDC"
                  className="w-full bg-surface-container border border-outline px-3 py-2 rounded-lg text-sm font-data-mono"
                />
                {amountRawInput && (
                  <span className="text-[11px] text-on-surface-variant font-data-mono">
                    Formatted: {formatUsdc(BigInt(amountRawInput))} USDC
                  </span>
                )}
              </div>
            </>
          )}

          {(selectedKind === "treasury.set_paused" || selectedKind === "market_core.set_paused") && (
            <div className="space-y-2">
              <label className="text-xs font-bold uppercase text-on-surface-variant">Paused State</label>
              <select
                value={pausedState ? "true" : "false"}
                onChange={(e) => setPausedState(e.target.value === "true")}
                className="w-full bg-surface-container border border-outline px-3 py-2 rounded-lg text-sm font-data-mono"
              >
                <option value="true">PAUSED (true)</option>
                <option value="false">UNPAUSED (false)</option>
              </select>
            </div>
          )}

          {selectedKind === "treasury.collect_market_fees" && (
            <div className="space-y-2">
              <label className="text-xs font-bold uppercase text-on-surface-variant">Market IDs (comma separated)</label>
              <input
                type="text"
                value={marketIdsInput}
                onChange={(e) => setMarketIdsInput(e.target.value)}
                placeholder="1, 2, 3"
                className="w-full bg-surface-container border border-outline px-3 py-2 rounded-lg text-sm font-data-mono"
              />
            </div>
          )}
        </div>

        <div className="flex gap-4">
          <button
            type="button"
            onClick={() => handlePrepare(false)}
            disabled={isSubmitting || !isAuthorized}
            className="px-6 py-2.5 rounded-lg bg-primary text-primary-foreground font-bold text-xs uppercase tracking-wider hover:brightness-110 active:scale-95 transition-all disabled:opacity-50"
          >
            {isSubmitting ? "Preparing..." : "Prepare Operation"}
          </button>
        </div>
      </div>

      {/* Force Confirmation Dialog for PREFLIGHT_FAILED */}
      <Dialog open={showForceConfirm} onOpenChange={setShowForceConfirm}>
        <DialogContent className="max-w-md bg-surface p-6 rounded-xl border border-error">
          <DialogTitle className="text-error font-bold flex items-center gap-2">
            <Icon name="warning" />
            <span>Preflight Checks Failed</span>
          </DialogTitle>
          <DialogDescription className="text-xs text-on-surface-variant mt-2">
            The safety preflight simulation detected the following issues. Proceeding requires the &lsquo;force&rsquo; override.
          </DialogDescription>
          <ul className="mt-4 divide-y divide-outline-variant/40 text-xs">
            {failingChecks.map((check, idx) => (
              <li key={idx} className="py-2 flex items-center justify-between">
                <span className="font-semibold text-on-surface">{check.name}</span>
                <span className="text-error">{check.message || "Failed"}</span>
              </li>
            ))}
          </ul>
          <div className="mt-6 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setShowForceConfirm(false)}
              className="px-4 py-2 rounded-lg border border-outline text-xs uppercase font-bold"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => handlePrepare(true)}
              className="px-4 py-2 rounded-lg bg-error text-white text-xs uppercase font-bold hover:brightness-110"
            >
              Force Prepare
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Verification & Review Section */}
      {operation && (
        <div className="p-6 rounded-xl border border-outline-variant bg-surface space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-outline-variant/40 pb-4">
            <div>
              <h2 className="font-headline-sm text-headline-sm text-on-surface">2. Independent XDR Verification</h2>
              <p className="text-xs text-on-surface-variant font-data-mono mt-0.5">Operation ID: {operation.id}</p>
            </div>
            {secondsRemaining !== null && (
              <span className={`px-2.5 py-1 rounded text-xs font-data-mono font-bold ${secondsRemaining <= 60 ? "bg-error/20 text-error" : "bg-surface-container text-on-surface"}`}>
                Expires in: {Math.floor(secondsRemaining / 60)}m {secondsRemaining % 60}s
              </span>
            )}
          </div>

          {/* Verification Result Banner */}
          {verificationError ? (
            <div role="alert" className="p-4 rounded-lg bg-error/15 border border-error text-error text-sm space-y-1">
              <div className="font-bold flex items-center gap-2">
                <Icon name="block" />
                <span>SIGNING BLOCKED: Prepared XDR Verification Failed</span>
              </div>
              <p className="text-xs">{verificationError}</p>
            </div>
          ) : decodedOp ? (
            <div className="p-4 rounded-lg bg-secondary/10 border border-secondary/20 text-secondary text-sm flex items-center gap-2">
              <Icon name="check_circle" filled />
              <span>Independent Verification Passed: The XDR exactly matches your requested parameters.</span>
            </div>
          ) : null}

          {/* Local Decoded Authority vs Untrusted Backend Summary */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-xs">
            {/* Authoritative Local Decoded View */}
            <div className="p-4 rounded-lg border border-outline-variant/60 bg-surface-container-low space-y-3">
              <div className="flex items-center justify-between border-b border-outline-variant/30 pb-2">
                <span className="font-bold uppercase tracking-wider text-on-surface flex items-center gap-1.5">
                  <Icon name="lock" className="text-[14px] text-secondary" />
                  Locally Decoded (Authority)
                </span>
                <span className="text-[10px] bg-secondary/20 text-secondary px-2 py-0.5 rounded font-bold">
                  VERIFIED
                </span>
              </div>
              {decodedOp && (
                <div className="space-y-1.5 font-data-mono">
                  <div>Contract: {decodedOp.contractName} ({decodedOp.contractId})</div>
                  <div>Function: {decodedOp.functionName}</div>
                  <div>Source Account: {decodedOp.sourceAccount}</div>
                  <div>Fee: {formatUsdc(decodedOp.feeStroops)} XLM</div>
                  <div>Arguments: {JSON.stringify(decodedOp.decodedArgs, (_, v) => typeof v === 'bigint' ? v.toString() : v)}</div>
                  <div>Hash: {decodedOp.hash}</div>
                </div>
              )}
            </div>

            {/* Backend Untrusted Summary */}
            <div className="p-4 rounded-lg border border-outline-variant/60 bg-surface-container-low space-y-3">
              <div className="flex items-center justify-between border-b border-outline-variant/30 pb-2">
                <span className="font-bold uppercase tracking-wider text-on-surface-variant flex items-center gap-1.5">
                  <Icon name="info" className="text-[14px]" />
                  Backend Description
                </span>
                <span className="text-[10px] bg-outline-variant text-on-surface-variant px-2 py-0.5 rounded font-bold">
                  UNVERIFIED TEXT
                </span>
              </div>
              <p className="font-data-mono text-on-surface-variant leading-relaxed">
                {operation.humanSummary}
              </p>
            </div>
          </div>

          {/* Multi-Signer Weight & Threshold Tracking */}
          <div className="p-4 rounded-lg border border-outline-variant bg-surface-container-low space-y-3 text-xs">
            <div className="flex items-center justify-between border-b border-outline-variant/30 pb-2">
              <span className="font-bold uppercase tracking-wider text-on-surface">
                Collected Weight Status (Backend High Threshold Requirement)
              </span>
              <span className={`px-2 py-0.5 rounded font-bold uppercase ${isReady ? "bg-secondary text-primary-foreground" : "bg-outline-variant text-on-surface-variant"}`}>
                {isReady ? "READY FOR SUBMISSION" : "AWAITING SIGNATURES"}
              </span>
            </div>

            <div className="flex items-baseline gap-2">
              <span className="font-display-lg text-2xl font-bold">{collectedWeight}</span>
              <span className="text-on-surface-variant">/ {operation.requiredThreshold} required weight (HIGH)</span>
            </div>

            <div className="space-y-1">
              <span className="font-semibold text-on-surface">Required Signers:</span>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
                {operation.requiredSigners.map((s) => {
                  const hasSigned = operation.signatures.some((sig) => sig.signer === s.key);
                  return (
                    <div key={s.key} className="p-2 rounded bg-surface border border-outline-variant flex items-center justify-between font-data-mono">
                      <span>{s.key.slice(0, 8)}…{s.key.slice(-6)} (Weight: {s.weight})</span>
                      <span className={`text-[10px] font-bold uppercase ${hasSigned ? "text-secondary" : "text-on-surface-variant"}`}>
                        {hasSigned ? "Signed" : "Pending"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Actions: Sign, Submit, Cancel */}
          <div className="flex flex-wrap gap-4 pt-2">
            <button
              type="button"
              onClick={handleSign}
              disabled={isSigning || isExpired || Boolean(verificationError)}
              className="px-6 py-2.5 rounded-lg bg-secondary text-primary-foreground font-bold text-xs uppercase tracking-wider hover:brightness-110 active:scale-95 transition-all disabled:opacity-50"
            >
              {isSigning ? "Signing..." : "Sign with Wallet"}
            </button>

            <button
              type="button"
              onClick={handleSubmit}
              disabled={isSubmitting || !isReady || isExpired || !isTestnet}
              className="px-6 py-2.5 rounded-lg bg-primary text-primary-foreground font-bold text-xs uppercase tracking-wider hover:brightness-110 active:scale-95 transition-all disabled:opacity-50"
            >
              {isSubmitting ? "Submitting..." : isTestnet ? "Submit to Network" : "Submit (Testnet Only)"}
            </button>

            <button
              type="button"
              onClick={handleCancel}
              disabled={isSubmitting}
              className="px-6 py-2.5 rounded-lg border border-outline text-on-surface font-bold text-xs uppercase tracking-wider hover:bg-surface-container transition-all"
            >
              Cancel Operation
            </button>
          </div>
        </div>
      )}

      {statusMessage && (
        <div className="p-4 rounded-xl border border-outline bg-surface-container text-xs font-data-mono">
          {statusMessage}
        </div>
      )}
    </div>
  );
}
