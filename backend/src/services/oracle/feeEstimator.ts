// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

/**
 * Typed public surface for the automated gas price oracle and Soroban fee
 * estimator (#1776).
 *
 * The runtime implementation lives in `feeEstimator.js` because the production
 * image runs Node 20, which cannot execute TypeScript directly. This module
 * re-exports the runtime API and provides the strongly typed contracts used by
 * TypeScript consumers and tests.
 */

import { feeEstimator as defaultFeeEstimator } from './feeEstimatorCore.js';

export {
  BASE_FEE_STROOPS,
  FEE_CACHE_TTL_SECONDS,
  LEDGER_SAMPLE_SIZE,
  FEE_SPIKE_THRESHOLD_RATIO,
  INSTRUCTIONS_INCREMENT,
  DATA_SIZE_1KB_INCREMENT,
  TX_BASE_RESULT_SIZE,
  STROOPS_PER_XLM,
  SUPPORTED_NETWORKS,
  DEFAULT_HORIZON_URLS,
  DEFAULT_FEE_CONFIG,
  InvalidNetworkError,
  normalizeNetwork,
  calculatePercentile,
  computePercentiles,
  computeFeePerIncrement,
  normalizeResourceUsage,
  computeResourceFee,
  buildFeeRecommendations,
  FeeEstimator,
  feeEstimator,
} from './feeEstimatorCore.js';

export default defaultFeeEstimator;

export type StellarNetwork = 'testnet' | 'mainnet' | 'futurenet' | 'local';

export interface SorobanResourceUsage {
  cpuInstructions?: number;
  memoryBytes?: number;
  readEntries?: number;
  writeEntries?: number;
  readBytes?: number;
  writeBytes?: number;
  transactionSizeBytes?: number;
  eventsSizeBytes?: number;
  returnValueSizeBytes?: number;
  cpuInsns?: number;
  memBytes?: number;
  readCount?: number;
  writeCount?: number;
  ledgerReadBytes?: number;
  ledgerWriteBytes?: number;
}

export interface NormalizedResourceUsage {
  cpuInstructions: number;
  memoryBytes: number;
  readEntries: number;
  writeEntries: number;
  readBytes: number;
  writeBytes: number;
  transactionSizeBytes: number;
  eventsSizeBytes: number;
  returnValueSizeBytes: number;
}

export interface SorobanFeeConfig {
  feePerInstructionIncrement: number;
  feePerDiskReadEntry: number;
  feePerWriteEntry: number;
  feePerDiskRead1kb: number;
  feePerWrite1kb: number;
  feePerHistorical1kb: number;
  feePerContractEvent1kb: number;
  feePerTransactionSize1kb: number;
  feePerMemory1kb: number;
}

export interface FeePercentiles {
  p10: number;
  p50: number;
  p90: number;
  p99: number;
}

export interface ResourceFeeBreakdown {
  instructions: number;
  diskReadEntries: number;
  writeEntries: number;
  diskReadBytes: number;
  writeBytes: number;
  historical: number;
  contractEvents: number;
  transactionSize: number;
  memory: number;
}

export interface ResourceFeeEstimate {
  nonRefundableStroops: number;
  refundableStroops: number;
  totalStroops: number;
  inputs: NormalizedResourceUsage;
  breakdown: ResourceFeeBreakdown;
}

export interface FeeRecommendation {
  tier: 'slow' | 'normal' | 'urgent';
  feePerOperationStroops: number;
  inclusionFeeStroops: number;
  resourceFeeStroops: number;
  totalFeeStroops: number;
  totalFeeXlm: number;
}

export interface FeeRecommendations {
  slow: FeeRecommendation;
  normal: FeeRecommendation;
  urgent: FeeRecommendation;
}

export interface LedgerFeeSample {
  ledger: number;
  transactionCount: number;
  medianFeePerOperation: number;
  p90FeePerOperation: number;
}

export interface FeeSpikeAlert {
  network: StellarNetwork | string;
  fromLedger: number;
  toLedger: number;
  previousMedianFeePerOperation: number;
  currentMedianFeePerOperation: number;
  changePercent: number;
  direction: 'increase' | 'decrease';
  thresholdPercent: number;
  detectedAt: number;
}

export interface FeeEstimateOptions extends SorobanResourceUsage {
  network?: StellarNetwork | string;
  operationCount?: number;
  resource?: SorobanResourceUsage;
}

export interface FeeEstimateResult {
  network: StellarNetwork | string;
  cached: boolean;
  source: 'ledgers' | 'fee_stats' | 'fallback';
  degraded: boolean;
  generatedAt: number;
  sampleCount: number;
  ledgerRange: {
    fromLedger: number | null;
    toLedger: number | null;
    ledgerCount: number;
  };
  percentiles: FeePercentiles;
  operationCount: number;
  resourceUsage: NormalizedResourceUsage;
  resourceFee: {
    nonRefundableStroops: number;
    refundableStroops: number;
    totalStroops: number;
    breakdown: ResourceFeeBreakdown;
  };
  recommendations: FeeRecommendations;
  inclusionFee: {
    slow: number;
    normal: number;
    urgent: number;
  };
  totalFee: {
    slow: number;
    normal: number;
    urgent: number;
  };
  alert: FeeSpikeAlert | null;
  error?: string;
  perLedger: LedgerFeeSample[];
}

export interface FeeEstimatorOptions {
  fetchImpl?: typeof fetch;
  redis?: {
    get(key: string): Promise<unknown>;
    set(key: string, value: string, ttl?: number): Promise<unknown>;
  } | null;
  now?: () => number;
  horizonUrls?: Partial<Record<StellarNetwork, string>>;
  cacheTtlSeconds?: number;
  ledgerSampleSize?: number;
  requestTimeoutMs?: number;
  spikeThresholdRatio?: number;
  feeConfig?: Partial<SorobanFeeConfig>;
  logger?: Pick<Console, 'warn'>;
}
