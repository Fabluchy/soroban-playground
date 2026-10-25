// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

/** Local Groth16 verifier for Ethereum/Soroban uncompressed BN254 points. */

import { bn254 } from '@noble/curves/bn254';
import type {
  Groth16ProofPoints,
  ZkPublicInputs,
  ZkVerificationKey,
  ZkCredential,
  ZkVerificationResult,
  ZkExportToken,
} from './types';

const FR_MODULUS = bn254.params.r;
const FQ_MODULUS = bn254.fields.Fp.ORDER;

function cleanHex(value: string): string {
  return value.startsWith('0x') ? value.slice(2) : value;
}

function decodeCoordinate(hex: string): bigint {
  const clean = cleanHex(hex);
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error('Coordinate must be 32-byte hexadecimal');
  const value = BigInt(`0x${clean}`);
  if (value >= FQ_MODULUS) throw new Error('Coordinate is outside the BN254 base field');
  return value;
}

function g1FromHex(hex: string) {
  const clean = cleanHex(hex);
  if (!/^[0-9a-fA-F]{128}$/.test(clean)) throw new Error('G1 point must be 64-byte hexadecimal');
  const point = bn254.G1.ProjectivePoint.fromAffine({
    x: decodeCoordinate(clean.slice(0, 64)),
    y: decodeCoordinate(clean.slice(64)),
  });
  point.assertValidity();
  if (!point.isTorsionFree()) throw new Error('G1 point is outside the prime-order subgroup');
  return point;
}

function g2FromHex(hex: string) {
  const clean = cleanHex(hex);
  if (!/^[0-9a-fA-F]{256}$/.test(clean)) throw new Error('G2 point must be 128-byte hexadecimal');
  // The Soroban contract encoding is X.c1 || X.c0 || Y.c1 || Y.c0.
  const xC1 = decodeCoordinate(clean.slice(0, 64));
  const xC0 = decodeCoordinate(clean.slice(64, 128));
  const yC1 = decodeCoordinate(clean.slice(128, 192));
  const yC0 = decodeCoordinate(clean.slice(192, 256));
  const point = bn254.G2.ProjectivePoint.fromAffine({
    x: bn254.fields.Fp2.fromBigTuple([xC0, xC1]),
    y: bn254.fields.Fp2.fromBigTuple([yC0, yC1]),
  });
  point.assertValidity();
  if (!point.isTorsionFree()) throw new Error('G2 point is outside the prime-order subgroup');
  return point;
}

function parseSignal(value: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error('Public signals must be canonical unsigned decimal strings');
  }
  const scalar = BigInt(value);
  if (scalar >= FR_MODULUS) throw new Error('Public signal is outside the BN254 scalar field');
  return scalar;
}

/** Check expected hexadecimal encoding length. This does not validate a point. */
export function validateProofPointEncoding(pointHex: string, expectedBytes: number): boolean {
  if (!pointHex || typeof pointHex !== 'string') return false;
  return new RegExp(`^[0-9a-fA-F]{${expectedBytes * 2}}$`).test(cleanHex(pointHex));
}

/** Verify a Groth16 proof locally against the supplied circuit key and signals. */
export function verifyZkProof(
  proof: Groth16ProofPoints,
  publicInputs: ZkPublicInputs,
  vk: ZkVerificationKey,
): ZkVerificationResult {
  const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const finish = (isValid: boolean, errorReason?: string): ZkVerificationResult => ({
    isValid,
    verificationLatencyMs: Number(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - start).toFixed(2)),
    verifiedAt: Date.now(),
    verificationMethod: 'GROTH16_BN254',
    ...(errorReason ? { errorReason } : {}),
  });

  try {
    if (publicInputs.expirationTimestamp && publicInputs.expirationTimestamp > 0 && publicInputs.expirationTimestamp < Math.floor(Date.now() / 1000)) {
      return finish(false, 'Credential has expired');
    }
    const signals = publicInputs.signals;
    if (!signals) return finish(false, 'Ordered circuit public signals are required for local proof verification');
    if (signals.length > 64 || vk.ic.length !== signals.length + 1) {
      return finish(false, 'Verification key IC length must equal public signal count plus one');
    }

    const a = g1FromHex(proof.a);
    const b = g2FromHex(proof.b);
    const c = g1FromHex(proof.c);
    const alpha = g1FromHex(vk.alphaG1);
    const beta = g2FromHex(vk.betaG2);
    const gamma = g2FromHex(vk.gammaG2);
    const delta = g2FromHex(vk.deltaG2);
    const scalars = signals.map(parseSignal);
    const ic = vk.ic.map(g1FromHex);

    let vkX = ic[0];
    for (let index = 0; index < scalars.length; index += 1) {
      vkX = vkX.add(ic[index + 1].multiply(scalars[index]));
    }

    // e(A,B) * e(-vkX,gamma) * e(-C,delta) * e(-alpha,beta) = 1
    const product = bn254.pairingBatch([
      { g1: a, g2: b },
      { g1: vkX.negate(), g2: gamma },
      { g1: c.negate(), g2: delta },
      { g1: alpha.negate(), g2: beta },
    ]);
    return finish(bn254.fields.Fp12.eql(product, bn254.fields.Fp12.ONE),
      bn254.fields.Fp12.eql(product, bn254.fields.Fp12.ONE) ? undefined : 'Groth16 pairing check failed');
  } catch (error) {
    return finish(false, error instanceof Error ? error.message : 'Malformed Groth16 proof or verification key');
  }
}

export function verifyZkCredential(credential: ZkCredential): ZkVerificationResult {
  return verifyZkProof(credential.proof, credential.publicInputs, credential.verificationKey);
}

function asSnarkJsG1(point: string): [string, string, '1'] {
  const clean = cleanHex(point);
  return [BigInt(`0x${clean.slice(0, 64)}`).toString(), BigInt(`0x${clean.slice(64)}`).toString(), '1'];
}

function asSnarkJsG2(point: string): [[string, string], [string, string], ['1', '0']] {
  const clean = cleanHex(point);
  const xC1 = BigInt(`0x${clean.slice(0, 64)}`).toString();
  const xC0 = BigInt(`0x${clean.slice(64, 128)}`).toString();
  const yC1 = BigInt(`0x${clean.slice(128, 192)}`).toString();
  const yC0 = BigInt(`0x${clean.slice(192)}`).toString();
  // SnarkJS uses the same Fp2 tuple order as circomlib's bn128 implementation.
  return [[xC0, xC1], [yC0, yC1], ['1', '0']];
}

function toSnarkJsProof(proof: Groth16ProofPoints) {
  return {
    pi_a: asSnarkJsG1(proof.a),
    pi_b: asSnarkJsG2(proof.b),
    pi_c: asSnarkJsG1(proof.c),
    protocol: 'groth16' as const,
    curve: 'bn128' as const,
  };
}

function toSnarkJsVerificationKey(key: ZkVerificationKey, publicCount: number) {
  return {
    protocol: 'groth16' as const,
    curve: 'bn128' as const,
    nPublic: publicCount,
    vk_alpha_1: asSnarkJsG1(key.alphaG1),
    vk_beta_2: asSnarkJsG2(key.betaG2),
    vk_gamma_2: asSnarkJsG2(key.gammaG2),
    vk_delta_2: asSnarkJsG2(key.deltaG2),
    IC: key.ic.map(asSnarkJsG1),
  };
}

/** Export a SnarkJS-compatible Groth16 proof/key/input bundle plus UI metadata. */
export async function exportCredentialToken(credential: ZkCredential): Promise<ZkExportToken> {
  if (!verifyZkCredential(credential).isValid) {
    throw new Error('Cannot export a credential whose Groth16 proof has not verified');
  }
  const publicSignals = credential.publicInputs.signals ?? [];
  return {
    version: '1.0.0',
    type: 'ZkVerifiableCredential',
    credentialId: credential.id,
    issuer: credential.issuer,
    claim: credential.publicInputs.claimStatement,
    publicInputs: credential.publicInputs,
    proof: credential.proof,
    verificationKey: credential.verificationKey,
    publicSignals,
    groth16: {
      protocol: 'groth16',
      curve: 'bn128',
      proof: toSnarkJsProof(credential.proof),
      publicSignals,
      verificationKey: toSnarkJsVerificationKey(credential.verificationKey, publicSignals.length),
    },
    exportedAt: Date.now(),
  } as ZkExportToken;
}

/** Ensure portable bundle structure is complete; cryptographic validity requires verifyZkProof. */
export async function validateExportedToken(token: ZkExportToken): Promise<boolean> {
  if (!token || token.version !== '1.0.0' || token.type !== 'ZkVerifiableCredential' ||
    !token.groth16 || token.groth16.protocol !== 'groth16' || token.groth16.curve !== 'bn128' ||
    !Array.isArray(token.publicSignals) || !token.verificationKey || !token.proof ||
    !token.publicInputs) return false;
  try {
    if (
      JSON.stringify(token.publicInputs.signals ?? []) !== JSON.stringify(token.publicSignals) ||
      JSON.stringify(token.groth16.publicSignals) !== JSON.stringify(token.publicSignals) ||
      JSON.stringify(token.groth16.proof) !== JSON.stringify(toSnarkJsProof(token.proof)) ||
      JSON.stringify(token.groth16.verificationKey) !== JSON.stringify(toSnarkJsVerificationKey(token.verificationKey, token.publicSignals.length))
    ) return false;
    return verifyZkProof(token.proof, { ...token.publicInputs, signals: token.publicSignals }, token.verificationKey).isValid;
  } catch {
    return false;
  }
}
