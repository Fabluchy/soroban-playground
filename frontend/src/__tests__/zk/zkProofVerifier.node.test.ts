// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

/**
 * @file zkProofVerifier.node.test.ts
 * Unit tests for Zero-Knowledge proof verification, public input checks,
 * fail-closed behavior and portable Groth16 token exports.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  verifyZkProof,
  verifyZkCredential,
  exportCredentialToken,
  validateProofPointEncoding,
} from "../../lib/zk/zkProofVerifier.ts";
import { SAMPLE_CREDENTIALS } from "../../lib/zk/sampleCredentials.ts";

test("validateProofPointEncoding validates uncompressed curve hex lengths", () => {
  // G1 point: 64 bytes = 128 hex chars
  const validG1 = "a".repeat(128);
  assert.equal(validateProofPointEncoding(validG1, 64), true);

  // Invalid length
  assert.equal(validateProofPointEncoding("abc", 64), false);

  // G2 point: 128 bytes = 256 hex chars
  const validG2 = "b".repeat(256);
  assert.equal(validateProofPointEncoding(validG2, 128), true);
  assert.equal(validateProofPointEncoding(validG2, 64), false);

  // Non-hex chars
  assert.equal(validateProofPointEncoding("z".repeat(128), 64), false);
});

test("verifyZkProof fails closed when circuit signals are missing", () => {
  const devScoreCred = SAMPLE_CREDENTIALS[0];
  const result = verifyZkProof(
    devScoreCred.proof,
    devScoreCred.publicInputs,
    devScoreCred.verificationKey,
  );

  assert.equal(result.isValid, false);
  assert.match(result.errorReason ?? "", /Ordered circuit public signals/);
  assert.equal(result.verificationMethod, "GROTH16_BN254");
  assert.ok(
    result.verificationLatencyMs < 1000,
    "Local verification should complete in under one second",
  );
});

test("verifyZkProof does not accept synthetic KYC fixture", () => {
  const kycCred = SAMPLE_CREDENTIALS[1];
  const result = verifyZkCredential(kycCred);

  assert.equal(result.isValid, false);
});

test("verifyZkProof does not accept synthetic DAO fixture", () => {
  const councilCred = SAMPLE_CREDENTIALS[2];
  const result = verifyZkCredential(councilCred);

  assert.equal(result.isValid, false);
});

test("verifyZkProof rejects malformed proof points", () => {
  const devScoreCred = SAMPLE_CREDENTIALS[0];
  const corruptProof = {
    ...devScoreCred.proof,
    a: "corrupt_non_hex_point",
  };

  const result = verifyZkProof(
    corruptProof,
    { ...devScoreCred.publicInputs, signals: [] },
    {
      ...devScoreCred.verificationKey,
      ic: [devScoreCred.verificationKey.alphaG1],
    },
  );

  assert.equal(result.isValid, false);
  assert.ok(
    result.errorReason?.includes("G1 point must be 64-byte hexadecimal"),
  );
});

test("verifyZkProof rejects point at infinity or zero markers", () => {
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

  assert.equal(result.isValid, false);
});

test("verifyZkProof rejects tampered Merkle root or public inputs", () => {
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

  assert.equal(result.isValid, false);
});

test("verifyZkProof rejects expired credentials", () => {
  const devScoreCred = SAMPLE_CREDENTIALS[0];
  const expiredInputs = {
    ...devScoreCred.publicInputs,
    expirationTimestamp: 1000, // Year 1970 (expired)
  };

  const result = verifyZkProof(
    devScoreCred.proof,
    expiredInputs,
    devScoreCred.verificationKey,
  );

  assert.equal(result.isValid, false);
  assert.ok(result.errorReason?.includes("expired"));
});

test("exportCredentialToken refuses an unverified synthetic fixture", async () => {
  const devScoreCred = SAMPLE_CREDENTIALS[0];
  await assert.rejects(
    exportCredentialToken(devScoreCred),
    /proof has not verified/,
  );
});
