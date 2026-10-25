// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

/**
 * @file zkProofVerifier.test.ts
 * Jest unit test suite for Zero-Knowledge proof verification,
 * cryptographic verification and portable Groth16 token export.
 */

import {
  verifyZkProof,
  verifyZkCredential,
  exportCredentialToken,
  validateExportedToken,
  validateProofPointEncoding,
} from "../../lib/zk/zkProofVerifier";
import { SAMPLE_CREDENTIALS } from "../../lib/zk/sampleCredentials";
import { bn254 } from "@noble/curves/bn254";

const hex32 = (value: bigint) => value.toString(16).padStart(64, "0");
function validPairingFixture() {
  const g1 = bn254.G1.ProjectivePoint.BASE;
  const g2 = bn254.G2.ProjectivePoint.BASE;
  const g1Hex = (point: typeof g1) => {
    const affine = point.toAffine();
    return hex32(affine.x) + hex32(affine.y);
  };
  const g2Hex = () => {
    const affine = g2.toAffine();
    const x = bn254.fields.Fp2.reim(affine.x);
    const y = bn254.fields.Fp2.reim(affine.y);
    return hex32(x.im) + hex32(x.re) + hex32(y.im) + hex32(y.re);
  };
  const g2Point = g2Hex();
  return {
    proof: { a: g1Hex(g1.multiply(3n)), b: g2Point, c: g1Hex(g1) },
    key: {
      alphaG1: g1Hex(g1),
      betaG2: g2Point,
      gammaG2: g2Point,
      deltaG2: g2Point,
      ic: [g1Hex(g1)],
    },
    inputs: { ...SAMPLE_CREDENTIALS[0].publicInputs, signals: [] },
  };
}

describe("Zero-Knowledge Proof Verifier Engine", () => {
  describe("validateProofPointEncoding", () => {
    it("validates uncompressed curve hex string lengths", () => {
      const validG1 = "a".repeat(128);
      expect(validateProofPointEncoding(validG1, 64)).toBe(true);

      const validG2 = "b".repeat(256);
      expect(validateProofPointEncoding(validG2, 128)).toBe(true);
      expect(validateProofPointEncoding(validG2, 64)).toBe(false);

      expect(validateProofPointEncoding("abc", 64)).toBe(false);
      expect(validateProofPointEncoding("z".repeat(128), 64)).toBe(false);
    });
  });

  describe("verifyZkProof & verifyZkCredential", () => {
    it("cryptographically verifies a valid BN254 Groth16 pairing equation", () => {
      const fixture = validPairingFixture();
      const result = verifyZkProof(fixture.proof, fixture.inputs, fixture.key);
      expect(result.isValid).toBe(true);
      expect(result.verificationMethod).toBe("GROTH16_BN254");

      const changedSignals = verifyZkProof(
        fixture.proof,
        { ...fixture.inputs, signals: ["1"] },
        fixture.key,
      );
      expect(changedSignals.isValid).toBe(false);
    });

    it("rejects credentials without circuit public signals", () => {
      const devScoreCred = SAMPLE_CREDENTIALS[0];
      const result = verifyZkProof(
        devScoreCred.proof,
        devScoreCred.publicInputs,
        devScoreCred.verificationKey,
      );

      expect(result.isValid).toBe(false);
      expect(result.errorReason).toContain("Ordered circuit public signals");
      expect(result.verificationMethod).toBe("GROTH16_BN254");
      expect(result.verificationLatencyMs).toBeLessThan(1000);
    });

    it("does not accept the synthetic KYC fixture", () => {
      const kycCred = SAMPLE_CREDENTIALS[1];
      const result = verifyZkCredential(kycCred);

      expect(result.isValid).toBe(false);
    });

    it("does not accept the synthetic DAO fixture", () => {
      const councilCred = SAMPLE_CREDENTIALS[2];
      const result = verifyZkCredential(councilCred);

      expect(result.isValid).toBe(false);
    });

    it("rejects malformed proof points", () => {
      const fixture = validPairingFixture();
      const corruptProof = {
        ...fixture.proof,
        a: "corrupt_non_hex_point",
      };

      const result = verifyZkProof(corruptProof, fixture.inputs, fixture.key);

      expect(result.isValid).toBe(false);
      expect(result.errorReason).toContain(
        "G1 point must be 64-byte hexadecimal",
      );
    });

    it("rejects point at infinity or zero markers", () => {
      const devScoreCred = SAMPLE_CREDENTIALS[0];
      const zeroProof = {
        ...devScoreCred.proof,
        a: "0".repeat(128),
      };

      const result = verifyZkProof(
        zeroProof,
        devScoreCred.publicInputs,
        devScoreCred.verificationKey,
      );

      expect(result.isValid).toBe(false);
    });

    it("rejects tampered Merkle root or public inputs", () => {
      const devScoreCred = SAMPLE_CREDENTIALS[0];
      const tamperedInputs = {
        ...devScoreCred.publicInputs,
        merkleRoot: "short_root",
      };

      const result = verifyZkProof(
        devScoreCred.proof,
        tamperedInputs,
        devScoreCred.verificationKey,
      );

      expect(result.isValid).toBe(false);
    });

    it("rejects expired credentials", () => {
      const devScoreCred = SAMPLE_CREDENTIALS[0];
      const expiredInputs = {
        ...devScoreCred.publicInputs,
        expirationTimestamp: 1000, // Year 1970
      };

      const result = verifyZkProof(
        devScoreCred.proof,
        expiredInputs,
        devScoreCred.verificationKey,
      );

      expect(result.isValid).toBe(false);
      expect(result.errorReason).toContain("expired");
    });
  });

  describe("exportCredentialToken & validateExportedToken", () => {
    it("refuses to export synthetic unverified credentials", async () => {
      const devScoreCred = SAMPLE_CREDENTIALS[0];
      await expect(exportCredentialToken(devScoreCred)).rejects.toThrow(
        /proof has not verified/,
      );
    });

    it("exports a valid proof that the independent token validator accepts", async () => {
      const fixture = validPairingFixture();
      const credential = {
        ...SAMPLE_CREDENTIALS[0],
        proof: fixture.proof,
        verificationKey: fixture.key,
        publicInputs: fixture.inputs,
      };
      const token = await exportCredentialToken(credential);
      expect(token.groth16.publicSignals).toEqual([]);
      expect(await validateExportedToken(token)).toBe(true);
      const tampered = {
        ...token,
        groth16: {
          ...token.groth16,
          proof: { ...token.groth16.proof, pi_a: ["1", "1", "1"] },
        },
      };
      expect(await validateExportedToken(tampered)).toBe(false);
    });
  });
});
