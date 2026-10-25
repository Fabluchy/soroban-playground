// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

/**
 * @file sampleCredentials.ts
 * Synthetic UI fixtures. Proofs, keys, issuers, and claims are placeholders;
 * they must never be treated as authentic credentials.
 */

import type { ZkCredential, ZkVerificationKey } from './types';

// Deliberately synthetic verification key for UI fixtures only.
const SAMPLE_VERIFICATION_KEY: ZkVerificationKey = {
  alphaG1:
    '1a4b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d',
  betaG2:
    '2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e',
  gammaG2:
    '3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e',
  deltaG2:
    '4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e',
  ic: [
    '5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b',
    '6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c',
  ],
};

export const SAMPLE_CREDENTIALS: ZkCredential[] = [
  {
    id: 'zk-cred-dev-score-80',
    type: 'DEV_SCORE_80',
    title: 'Senior Soroban Developer',
    description: 'Synthetic UI example. This claim and proof are not verified.',
    issuer: 'Sample Developer Guild (demo)',
    issuerAddress: 'SAMPLE_ISSUER_DEV_GUILD',
    verified: false,
    verificationTimestamp: 1774160400,
    verificationMethod: 'GROTH16_BN254',
    verificationLatencyMs: 12.4,
    proof: {
      a: '11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff',
      b: 'aabbccddeeff11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff11223344556677889900',
      c: 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100',
    },
    publicInputs: {
      merkleRoot:
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      schemaId: 'stellar.soroban.developer.score.v1',
      claimStatement: 'ReputationScore >= 80',
      nullifierHash:
        '7d793037a0760186574b0282f2f435e70d71586e973ab45c6991c479b86b62d2',
      issuanceTimestamp: 1774160400,
      domain: 'soroban-playground',
    },
    verificationKey: SAMPLE_VERIFICATION_KEY,
  },
  {
    id: 'zk-cred-kyc-l2',
    type: 'KYC_LEVEL_2',
    title: 'Stellar KYC Verified (Level 2)',
    description: 'Synthetic UI example. This claim and proof are not verified.',
    issuer: 'Sample Identity Issuer (demo)',
    issuerAddress: 'SAMPLE_ISSUER_KYC',
    verified: false,
    verificationTimestamp: 1774074000,
    verificationMethod: 'GROTH16_BN254',
    verificationLatencyMs: 9.8,
    proof: {
      a: '3344556677889900aabbccddeeff11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff1122',
      b: 'ccddeeff11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff11223344556677889900aabb',
      c: '77889900aabbccddeeff11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff112233445566',
    },
    publicInputs: {
      merkleRoot:
        '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
      schemaId: 'stellar.kyc.compliance.level2.v1',
      claimStatement: 'KYCStatus == VerifiedTier2',
      nullifierHash:
        'a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0',
      issuanceTimestamp: 1774074000,
      expirationTimestamp: 1805600000,
      domain: 'soroban-playground',
    },
    verificationKey: SAMPLE_VERIFICATION_KEY,
  },
  {
    id: 'zk-cred-dao-council',
    type: 'DAO_COUNCIL',
    title: 'DAO Governance Council Member',
    description: 'Synthetic UI example. This claim and proof are not verified.',
    issuer: 'Sample DAO Issuer (demo)',
    issuerAddress: 'SAMPLE_ISSUER_DAO',
    verified: false,
    verificationTimestamp: 1773987600,
    verificationMethod: 'GROTH16_BN254',
    verificationLatencyMs: 14.2,
    proof: {
      a: '556677889900aabbccddeeff11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff11223344',
      b: 'eeff11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff11223344556677889900aabbccdd',
      c: '9900aabbccddeeff11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff1122334455667788',
    },
    publicInputs: {
      merkleRoot:
        '8c8e1a2f3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e',
      schemaId: 'stellar.dao.governance.council.v1',
      claimStatement: 'CouncilMembership == True',
      nullifierHash:
        'b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef01',
      issuanceTimestamp: 1773987600,
      domain: 'soroban-playground',
    },
    verificationKey: SAMPLE_VERIFICATION_KEY,
  },
  {
    id: 'zk-cred-unverified',
    type: 'ACCREDITED_INVESTOR',
    title: 'Accredited Investor Status',
    description: 'Synthetic UI example. This claim and proof are not verified.',
    issuer: 'Sample Accreditation Issuer (demo)',
    issuerAddress: 'SAMPLE_ISSUER_ACCREDITED',
    verified: false,
    verificationTimestamp: 0,
    verificationMethod: 'GROTH16_BN254',
    proof: {
      a: '00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
      b: '0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
      c: '00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
    },
    publicInputs: {
      merkleRoot:
        '0000000000000000000000000000000000000000000000000000000000000000',
      schemaId: 'stellar.investor.accredited.v1',
      claimStatement: 'NetWorth >= 1000000',
      nullifierHash:
        '0000000000000000000000000000000000000000000000000000000000000000',
      issuanceTimestamp: 0,
      domain: 'soroban-playground',
    },
    verificationKey: SAMPLE_VERIFICATION_KEY,
  },
];
