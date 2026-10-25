// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

/**
 * @file types.ts
 * Strict TypeScript definitions for Zero-Knowledge Identity (zkID)
 * verification, Groth16 proofs, public inputs, and portable credential tokens.
 */

export interface Groth16ProofPoints {
  /** G1 point: uncompressed X || Y (64 hex bytes) */
  a: string;
  /** G2 point: uncompressed X.c1 || X.c0 || Y.c1 || Y.c0 (128 hex bytes) */
  b: string;
  /** G1 point: uncompressed X || Y (64 hex bytes) */
  c: string;
}

export interface ZkVerificationKey {
  alphaG1: string;
  betaG2: string;
  gammaG2: string;
  deltaG2: string;
  ic: string[];
}

export interface ZkPublicInputs {
  /** Merkle root hash of the credential issuer registry */
  merkleRoot: string;
  /** Cryptographic identifier of the credential schema (e.g., KYC, Score) */
  schemaId: string;
  /** Public claim statement (e.g., "Score >= 80" or "KYC == true") */
  claimStatement: string;
  /** Non-linkable nullifier hash preventing double-spending / sybil duplication */
  nullifierHash: string;
  /** Issuance timestamp in unix epoch seconds */
  issuanceTimestamp: number;
  /** Expiration timestamp in unix epoch seconds (0 if non-expiring) */
  expirationTimestamp?: number;
  /** Contextual domain string (e.g., "soroban-playground") */
  domain?: string;
  /** Ordered canonical BN254 Fr elements bound by the circuit. */
  signals?: string[];
}

export type ZkCredentialType =
  | 'KYC_LEVEL_2'
  | 'DEV_SCORE_80'
  | 'DAO_COUNCIL'
  | 'ACCREDITED_INVESTOR';

export interface ZkCredential {
  id: string;
  type: ZkCredentialType;
  title: string;
  description: string;
  issuer: string;
  issuerAddress: string;
  verified: boolean;
  verificationTimestamp: number;
  verificationMethod: 'GROTH16_BN254' | 'SOROBAN_RPC_SIMULATION' | 'MERKLE_COMMITMENT';
  proof: Groth16ProofPoints;
  publicInputs: ZkPublicInputs;
  verificationKey: ZkVerificationKey;
  verificationLatencyMs?: number;
}

export interface ZkVerificationResult {
  isValid: boolean;
  verificationLatencyMs: number;
  verifiedAt: number;
  errorReason?: string;
  verificationMethod: string;
}

export interface ZkExportToken {
  version: '1.0.0';
  type: 'ZkVerifiableCredential';
  credentialId: string;
  issuer: string;
  claim: string;
  publicInputs: ZkPublicInputs;
  proof: Groth16ProofPoints;
  verificationKey: ZkVerificationKey;
  /** SnarkJS-compatible Groth16 input values, encoded as decimal strings. */
  publicSignals: string[];
  groth16: {
    protocol: 'groth16';
    curve: 'bn128';
    proof: Record<string, unknown>;
    publicSignals: string[];
    verificationKey: Record<string, unknown>;
  };
  exportedAt: number;
}
