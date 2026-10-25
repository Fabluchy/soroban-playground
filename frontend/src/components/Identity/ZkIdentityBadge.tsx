// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

/**
 * @file ZkIdentityBadge.tsx
 * Zero-Knowledge Identity (zkID) Verification Badge System.
 * Renders locally verified Groth16 credentials, proof details, and portable proof export.
 */

"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  ShieldCheck,
  ShieldAlert,
  Shield,
  CheckCircle2,
  Lock,
  Download,
  Copy,
  Check,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  Sparkles,
  X,
  FileCheck2,
  Fingerprint,
} from "lucide-react";
import type {
  ZkCredential,
  ZkVerificationResult,
  ZkExportToken,
} from "../../lib/zk/types";
import {
  verifyZkCredential,
  exportCredentialToken,
} from "../../lib/zk/zkProofVerifier";
import { SAMPLE_CREDENTIALS } from "../../lib/zk/sampleCredentials";

export interface ZkIdentityBadgeProps {
  credential?: ZkCredential;
  credentials?: ZkCredential[];
  mode?: "badge" | "card" | "list";
  showModalInitially?: boolean;
  onVerify?: (credentialId: string, result: ZkVerificationResult) => void;
  /** Optional Soroban verifier adapter; local Groth16 verification is the default. */
  verifyWithSoroban?: (credential: ZkCredential) => Promise<ZkVerificationResult>;
  onExport?: (token: ZkExportToken) => void;
  className?: string;
}

export default function ZkIdentityBadge({
  credential,
  credentials,
  mode = "badge",
  showModalInitially = false,
  onVerify,
  verifyWithSoroban,
  onExport,
  className = "",
}: ZkIdentityBadgeProps) {
  // If no single credential or list is provided, default to the Developer Score credential
  const activeCredentialList = useMemo(() => {
    if (credentials && credentials.length > 0) return credentials;
    if (credential) return [credential];
    return SAMPLE_CREDENTIALS;
  }, [credential, credentials]);

  const [selectedCred, setSelectedCred] = useState<ZkCredential>(
    credential || activeCredentialList[0]
  );
  const [isModalOpen, setIsModalOpen] = useState<boolean>(showModalInitially);
  const [verificationState, setVerificationState] = useState<
    Record<string, ZkVerificationResult | undefined>
  >({});
  const [isVerifying, setIsVerifying] = useState<boolean>(false);
  const [showRawProof, setShowRawProof] = useState<boolean>(false);
  const [copiedToken, setCopiedToken] = useState<boolean>(false);
  const [copiedNullifier, setCopiedNullifier] = useState<boolean>(false);

  // Close modal on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isModalOpen) {
        setIsModalOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isModalOpen]);

  // Local verification runner
  const handleVerify = useCallback(
    async (cred: ZkCredential) => {
      setIsVerifying(true);
      let result: ZkVerificationResult;
      try {
        result = verifyWithSoroban
          ? await verifyWithSoroban(cred)
          : verifyZkCredential(cred);
      } catch (error) {
        result = {
          isValid: false,
          verificationLatencyMs: 0,
          verifiedAt: Date.now(),
          verificationMethod: verifyWithSoroban ? "SOROBAN_RPC_SIMULATION" : "GROTH16_BN254",
          errorReason: error instanceof Error ? error.message : "Verifier request failed",
        };
      } finally {
        setIsVerifying(false);
      }
      setVerificationState((prev) => ({ ...prev, [cred.id]: result }));
      onVerify?.(cred.id, result);
    },
    [onVerify, verifyWithSoroban]
  );

  // Export portable JSON token
  const handleExport = useCallback(
    async (cred: ZkCredential) => {
      try {
        const token = await exportCredentialToken(cred);
        onExport?.(token);
        const jsonStr = JSON.stringify(token, null, 2);
        if (!navigator.clipboard) return;
        await navigator.clipboard.writeText(jsonStr);
        setCopiedToken(true);
        setTimeout(() => setCopiedToken(false), 2500);
      } catch {
        setCopiedToken(false);
      }
    },
    [onExport]
  );

  // Open modal for a specific credential
  const openProofModal = (cred: ZkCredential) => {
    setSelectedCred(cred);
    setIsModalOpen(true);
  };

  const currentResult = verificationState[selectedCred.id];
  const isVerified =
    currentResult?.isValid === true;

  // Render individual compact badge
  const renderBadge = (cred: ZkCredential) => {
    const credResult = verificationState[cred.id];
    const verified =
      credResult?.isValid === true;

    return (
      <button
        key={cred.id}
        type="button"
        data-testid={`zk-badge-${cred.id}`}
        onClick={() => openProofModal(cred)}
        className={`group relative inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-950 ${
          verified
            ? "border-emerald-500/40 bg-emerald-950/20 text-emerald-200 shadow-[0_0_15px_rgba(16,185,129,0.25)] hover:border-emerald-400 hover:bg-emerald-900/30 hover:shadow-[0_0_20px_rgba(16,185,129,0.4)] focus:ring-emerald-500"
            : "border-gray-800 bg-gray-900/40 text-gray-400 hover:border-gray-700 hover:text-gray-300 focus:ring-gray-600"
        } ${className}`}
        title="Click to inspect zero-knowledge cryptographic proof"
      >
        {/* Glowing authenticity checkmark indicator */}
        <div className="relative flex items-center justify-center">
          {verified ? (
            <>
              <span className="absolute -inset-1 rounded-full bg-emerald-500/30 blur-sm animate-pulse" />
              <CheckCircle2 className="relative h-4 w-4 text-emerald-400 drop-shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
            </>
          ) : (
            <ShieldAlert className="h-4 w-4 text-amber-500/80" />
          )}
        </div>

        <span className="font-semibold text-gray-200 group-hover:text-white">
          {cred.title}
        </span>

        <span
          className={`rounded-full px-2 py-0.2 text-[10px] font-mono font-bold ${
            verified
              ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
              : "bg-gray-800 text-gray-400"
          }`}
        >
          {verified ? "zkID Verified" : "Unverified"}
        </span>
      </button>
    );
  };

  // Render rich credential card
  const renderCard = (cred: ZkCredential) => {
    const credResult = verificationState[cred.id];
    const verified =
      credResult?.isValid === true;

    return (
      <div
        key={cred.id}
        data-testid={`zk-card-${cred.id}`}
        className={`relative overflow-hidden rounded-2xl border p-5 transition-all duration-300 ${
          verified
            ? "border-emerald-500/30 bg-gradient-to-b from-emerald-950/20 via-gray-950 to-gray-950 shadow-xl shadow-emerald-950/20"
            : "border-gray-800 bg-gray-900/40"
        }`}
      >
        {verified && (
          <div className="absolute -top-12 -right-12 h-32 w-32 rounded-full bg-emerald-500/10 blur-2xl pointer-events-none" />
        )}

        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div
              className={`flex h-11 w-11 items-center justify-center rounded-xl border ${
                verified
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400 shadow-[0_0_12px_rgba(16,185,129,0.3)]"
                  : "border-gray-800 bg-gray-900 text-gray-500"
              }`}
            >
              {verified ? (
                <ShieldCheck className="h-6 w-6" />
              ) : (
                <Shield className="h-6 w-6" />
              )}
            </div>

            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-white">
                  {cred.title}
                </h3>
                {verified && (
                  <span className="flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-bold text-emerald-300">
                    <Sparkles className="h-2.5 w-2.5" />
                    Verified
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-gray-400">
                Issuer: {cred.issuer}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => openProofModal(cred)}
            className="rounded-lg border border-gray-700 bg-gray-800/80 px-3 py-1.5 text-xs font-semibold text-gray-200 hover:border-emerald-500/50 hover:bg-gray-750 hover:text-white transition-all shadow-sm"
          >
            Inspect Proof
          </button>
        </div>

        <p className="mt-3 text-xs text-gray-300 leading-relaxed">
          {cred.description}
        </p>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-gray-800/80 pt-3 text-[11px] text-gray-500">
          <div className="flex items-center gap-1.5 text-emerald-400/90 font-medium">
            <Lock className="h-3 w-3" />
            <span>Claim is unverified</span>
          </div>
          <span className="font-mono text-gray-400">
            {cred.publicInputs.claimStatement}
          </span>
        </div>
      </div>
    );
  };

  return (
    <>
      {/* Primary Display Mode */}
      {mode === "badge" && (
        <div className="inline-flex flex-wrap gap-2">
          {activeCredentialList.map(renderBadge)}
        </div>
      )}

      {mode === "card" && (
        <div className="w-full">{renderCard(selectedCred)}</div>
      )}

      {mode === "list" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 w-full">
          {activeCredentialList.map(renderCard)}
        </div>
      )}

      {/* Detailed Cryptographic Proof Modal */}
      {isModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="zk-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md overflow-y-auto"
        >
          <div className="relative w-full max-w-2xl my-8 rounded-2xl border border-gray-800 bg-gray-950 p-6 shadow-2xl shadow-emerald-950/30 text-gray-100">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-gray-800 pb-4">
              <div className="flex items-center gap-3">
                <div
                  className={`flex h-11 w-11 items-center justify-center rounded-xl border ${
                    isVerified
                      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400 shadow-[0_0_15px_rgba(16,185,129,0.25)]"
                      : "border-gray-800 bg-gray-900 text-gray-400"
                  }`}
                >
                  <Fingerprint className="h-6 w-6" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2
                      id="zk-modal-title"
                      className="text-base font-semibold text-white"
                    >
                      Zero-Knowledge Proof Inspector
                    </h2>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-mono font-bold ${
                        isVerified
                          ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                          : "bg-gray-800 text-gray-400"
                      }`}
                    >
                      {isVerified ? "Cryptographically verified" : "Unverified"}
                    </span>
                  </div>
                  <p className="text-xs text-gray-400">
                    Proof status is unverified until the supplied proof and ordered public signals pass cryptographic verification.
                  </p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="rounded-lg p-2 text-gray-400 hover:bg-gray-800 hover:text-white transition-colors"
                aria-label="Close modal"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Public claim and privacy boundary note */}
            <div className="mt-5 rounded-xl border border-emerald-500/25 bg-emerald-950/15 p-3.5 text-xs text-emerald-200">
              <div className="flex items-start gap-2.5">
                <Lock className="h-4 w-4 text-emerald-400 mt-0.5 flex-shrink-0" />
                <div>
                  <span className="font-bold uppercase tracking-wider text-emerald-300">
                    Proof privacy
                  </span>
                  <p className="mt-0.5 text-emerald-300/80 leading-relaxed">
                    The stated claim is{" "}
                    <strong className="text-white font-mono">
                      {selectedCred.publicInputs.claimStatement}
                    </strong>{" "}
                    not confirmed by this demo. A valid proof establishes only the statement encoded by its circuit and key. Public signals are visible; private attributes must stay private in the circuit witness.
                  </p>
                </div>
              </div>
            </div>

            {/* Credential Details */}
            <div className="mt-4 rounded-xl border border-gray-800 bg-gray-900/40 p-4 space-y-3 text-xs">
              <div className="flex justify-between items-center pb-2 border-b border-gray-800">
                <span className="text-gray-400">Credential Type</span>
                <span className="font-semibold text-white">
                  {selectedCred.title}
                </span>
              </div>

              <div className="flex justify-between items-center pb-2 border-b border-gray-800">
                <span className="text-gray-400">Issuer Authority</span>
                <span className="text-gray-200">{selectedCred.issuer}</span>
              </div>

              <div className="flex justify-between items-center pb-2 border-b border-gray-800">
                <span className="text-gray-400">Issuance Timestamp (unverified metadata)</span>
                <span className="font-mono text-gray-200">
                  {new Date(selectedCred.publicInputs.issuanceTimestamp * 1000).toUTCString()}
                </span>
              </div>

              <div className="flex justify-between items-center">
                <span className="text-gray-400">Verification Method</span>
                <span className="font-mono text-indigo-300">
                  {currentResult?.isValid ? currentResult.verificationMethod : "Not verified"}
                </span>
              </div>
              {currentResult?.isValid && (
                <div className="flex justify-between items-center">
                  <span className="text-gray-400">Verified At</span>
                  <span className="font-mono text-gray-200">
                    {new Date(currentResult.verifiedAt).toUTCString()} ({currentResult.verificationLatencyMs} ms)
                  </span>
                </div>
              )}
            </div>

            {/* Public Inputs Matrix */}
            <div className="mt-4 rounded-xl border border-gray-800 bg-gray-900/60 p-4 text-xs">
              <div className="flex items-center gap-2 pb-2.5 border-b border-gray-800">
                <FileCheck2 className="h-4 w-4 text-indigo-400" />
                <h4 className="font-semibold uppercase tracking-wider text-gray-300 text-[11px]">
                  Canonical Public Inputs
                </h4>
              </div>

              <div className="mt-3 space-y-2.5 font-mono">
                <div>
                  <p className="text-[10px] uppercase text-gray-500 font-sans">
                    Registry Merkle Root Hash
                  </p>
                  <p className="mt-0.5 truncate text-gray-300 bg-gray-950 p-1.5 rounded border border-gray-800/80">
                    {selectedCred.publicInputs.merkleRoot}
                  </p>
                </div>

                <div>
                  <p className="text-[10px] uppercase text-gray-500 font-sans">
                    Schema Identifier
                  </p>
                  <p className="mt-0.5 text-gray-300 bg-gray-950 p-1.5 rounded border border-gray-800/80">
                    {selectedCred.publicInputs.schemaId}
                  </p>
                </div>

                <div>
                  <p className="text-[10px] uppercase text-gray-500 font-sans">
                    Ordered Circuit Public Signals
                  </p>
                  <p className="mt-0.5 break-all text-gray-300 bg-gray-950 p-1.5 rounded border border-gray-800/80">
                    {selectedCred.publicInputs.signals?.join(", ") || "Not supplied; local verification will fail closed"}
                  </p>
                </div>

                <div>
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] uppercase text-gray-500 font-sans">
                      Non-Linkable Nullifier Hash
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard?.writeText(
                          selectedCred.publicInputs.nullifierHash
                        );
                        setCopiedNullifier(true);
                        setTimeout(() => setCopiedNullifier(false), 2000);
                      }}
                      className="text-[10px] text-indigo-400 hover:text-indigo-300 font-sans flex items-center gap-1"
                    >
                      {copiedNullifier ? (
                        <Check className="h-3 w-3 text-emerald-400" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                      <span>Copy</span>
                    </button>
                  </div>
                  <p className="mt-0.5 truncate text-gray-300 bg-gray-950 p-1.5 rounded border border-gray-800/80">
                    {selectedCred.publicInputs.nullifierHash}
                  </p>
                </div>
              </div>
            </div>

            {/* Collapsible Raw Groth16 Proof Points */}
            <div className="mt-4">
              <button
                type="button"
                onClick={() => setShowRawProof(!showRawProof)}
                className="flex w-full items-center justify-between rounded-lg border border-gray-800 bg-gray-900/40 px-3 py-2 text-xs font-semibold text-gray-400 hover:text-white transition-colors"
              >
                <span>Raw Groth16 Proof Points (A, B, C)</span>
                {showRawProof ? (
                  <ChevronUp className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
              </button>

              {showRawProof && (
                <div className="mt-2 rounded-xl border border-gray-800 bg-gray-950 p-3 space-y-2 font-mono text-[11px] text-gray-400">
                  <div>
                    <span className="text-indigo-400 font-bold">π_a (G1):</span>
                    <p className="truncate text-gray-300">
                      {selectedCred.proof.a}
                    </p>
                  </div>
                  <div>
                    <span className="text-indigo-400 font-bold">π_b (G2):</span>
                    <p className="truncate text-gray-300">
                      {selectedCred.proof.b}
                    </p>
                  </div>
                  <div>
                    <span className="text-indigo-400 font-bold">π_c (G1):</span>
                    <p className="truncate text-gray-300">
                      {selectedCred.proof.c}
                    </p>
                  </div>
                </div>
              )}
            </div>

            {/* Actions Bar: Verify proof & export portable Groth16 token */}
            <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-gray-800 pt-4">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="verify-proof-btn"
                  disabled={isVerifying}
                  onClick={() => handleVerify(selectedCred)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-950/40 px-3 py-2 text-xs font-semibold text-emerald-300 hover:bg-emerald-900/50 hover:text-white transition-all shadow-sm"
                >
                  <RefreshCw
                    className={`h-3.5 w-3.5 ${
                      isVerifying ? "animate-spin" : ""
                    }`}
                  />
                  <span>
                    {isVerifying
                      ? "Verifying..."
                      : verifyWithSoroban
                      ? "Verify with Soroban"
                      : "Verify locally"}
                  </span>
                </button>

                {currentResult && (
                  <span className={`inline-flex items-center gap-1 text-[11px] font-mono ${currentResult.isValid ? "text-emerald-400" : "text-amber-300"}`}>
                    {currentResult.isValid
                    ? `Verified with ${currentResult.verificationMethod} in ${currentResult.verificationLatencyMs}ms`
                      : currentResult.errorReason}
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="export-token-btn"
                  disabled={!currentResult?.isValid}
                  onClick={() => handleExport(selectedCred)}
                  title={currentResult?.isValid ? "Export verified proof" : "Verify the credential before exporting"}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white shadow-md shadow-indigo-600/30 hover:bg-indigo-500 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {copiedToken ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-white" />
                      <span>Copied JSON!</span>
                    </>
                  ) : (
                    <>
                      <Download className="h-3.5 w-3.5" />
                      <span>Export Groth16 JSON</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="rounded-lg border border-gray-800 bg-gray-900 px-3.5 py-2 text-xs font-semibold text-gray-300 hover:bg-gray-800 transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
