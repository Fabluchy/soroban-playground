// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

import redisService from '../redisService.js';

export const BASE_FEE_STROOPS = 100;
export const FEE_CACHE_TTL_SECONDS = 5;
export const LEDGER_SAMPLE_SIZE = 20;
export const FEE_SPIKE_THRESHOLD_RATIO = 3;
export const INSTRUCTIONS_INCREMENT = 10_000;
export const DATA_SIZE_1KB_INCREMENT = 1024;
export const TX_BASE_RESULT_SIZE = 300;
export const STROOPS_PER_XLM = 10_000_000;

export const SUPPORTED_NETWORKS = ['testnet', 'mainnet', 'futurenet', 'local'];

export const DEFAULT_HORIZON_URLS = Object.freeze({
  testnet: 'https://horizon-testnet.stellar.org',
  mainnet: 'https://horizon.stellar.org',
  futurenet: 'https://horizon-futurenet.stellar.org',
  local: 'http://localhost:8000',
});

export const DEFAULT_FEE_CONFIG = Object.freeze({
  feePerInstructionIncrement: 100,
  feePerDiskReadEntry: 5_000,
  feePerWriteEntry: 20_000,
  feePerDiskRead1kb: 1_000,
  feePerWrite1kb: 3_500,
  feePerHistorical1kb: 100,
  feePerContractEvent1kb: 200,
  feePerTransactionSize1kb: 2_000,
  feePerMemory1kb: 0,
});

const HORIZON_ENV_KEYS = {
  testnet: 'HORIZON_TESTNET_URL',
  mainnet: 'HORIZON_MAINNET_URL',
  futurenet: 'HORIZON_FUTURENET_URL',
  local: 'HORIZON_LOCAL_URL',
};

export class InvalidNetworkError extends Error {
  constructor(network) {
    super(`Unsupported Stellar network: ${network}`);
    this.name = 'InvalidNetworkError';
    this.code = 'INVALID_NETWORK';
  }
}

function toNonNegativeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function toNonNegativeInteger(value, fallback = 0) {
  return Math.floor(toNonNegativeNumber(value, fallback));
}

function toPositiveInteger(value, fallback = 1) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function pickNumber(source, keys, fallback = 0) {
  for (const key of keys) {
    if (source && source[key] !== undefined && source[key] !== null) {
      return toNonNegativeNumber(source[key], fallback);
    }
  }
  return fallback;
}

export function normalizeNetwork(network = 'testnet') {
  const normalized = String(network).toLowerCase();
  if (!SUPPORTED_NETWORKS.includes(normalized)) {
    throw new InvalidNetworkError(network);
  }
  return normalized;
}

function buildHorizonUrls(overrides = {}) {
  const urls = {};
  for (const network of SUPPORTED_NETWORKS) {
    const envKey = HORIZON_ENV_KEYS[network];
    urls[network] =
      overrides[network] ||
      (envKey ? process.env[envKey] : undefined) ||
      DEFAULT_HORIZON_URLS[network];
  }
  return urls;
}

export function calculatePercentile(values, percentile) {
  if (!Array.isArray(values) || values.length === 0) return 0;

  const sorted = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);

  if (sorted.length === 0) return 0;
  if (percentile <= 0) return sorted[0];
  if (percentile >= 100) return sorted[sorted.length - 1];

  const rank = (percentile / 100) * (sorted.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const weight = rank - lowerIndex;

  if (lowerIndex === upperIndex) return sorted[lowerIndex];

  return sorted[lowerIndex] * (1 - weight) + sorted[upperIndex] * weight;
}

export function computePercentiles(values) {
  return {
    p10: Math.round(calculatePercentile(values, 10)),
    p50: Math.round(calculatePercentile(values, 50)),
    p90: Math.round(calculatePercentile(values, 90)),
    p99: Math.round(calculatePercentile(values, 99)),
  };
}

export function computeFeePerIncrement(
  resourceValue,
  feeRate,
  increment = DATA_SIZE_1KB_INCREMENT
) {
  const resource = toNonNegativeNumber(resourceValue);
  const rate = toNonNegativeNumber(feeRate);
  const step = toNonNegativeNumber(increment);
  if (step === 0) return 0;
  return Math.ceil((resource * rate) / step);
}

export function normalizeResourceUsage(input = {}) {
  const source = input.resource || input;

  return {
    cpuInstructions: pickNumber(source, ['cpuInstructions', 'cpuInsns']),
    memoryBytes: pickNumber(source, ['memoryBytes', 'memBytes']),
    readEntries: pickNumber(source, [
      'readEntries',
      'readCount',
      'diskReadEntries',
    ]),
    writeEntries: pickNumber(source, [
      'writeEntries',
      'writeCount',
      'writeLedgerEntries',
    ]),
    readBytes: pickNumber(source, [
      'readBytes',
      'ledgerReadBytes',
      'diskReadBytes',
    ]),
    writeBytes: pickNumber(source, [
      'writeBytes',
      'ledgerWriteBytes',
      'writeBytesLedger',
    ]),
    transactionSizeBytes: pickNumber(source, [
      'transactionSizeBytes',
      'txSizeBytes',
      'transactionSize',
    ]),
    eventsSizeBytes: pickNumber(source, [
      'eventsSizeBytes',
      'eventSizeBytes',
      'contractEventsSizeBytes',
    ]),
    returnValueSizeBytes: pickNumber(source, [
      'returnValueSizeBytes',
      'returnValueSize',
    ]),
  };
}

export function computeResourceFee(usage = {}, feeConfig = DEFAULT_FEE_CONFIG) {
  const config = { ...DEFAULT_FEE_CONFIG, ...(feeConfig || {}) };
  const inputs = normalizeResourceUsage(usage);

  if (Object.values(inputs).every((value) => value === 0)) {
    return {
      nonRefundableStroops: 0,
      refundableStroops: 0,
      totalStroops: 0,
      inputs,
      breakdown: {
        instructions: 0,
        diskReadEntries: 0,
        writeEntries: 0,
        diskReadBytes: 0,
        writeBytes: 0,
        historical: 0,
        contractEvents: 0,
        transactionSize: 0,
        memory: 0,
      },
    };
  }

  const instructions = computeFeePerIncrement(
    inputs.cpuInstructions,
    config.feePerInstructionIncrement,
    INSTRUCTIONS_INCREMENT
  );
  const diskReadEntries =
    toNonNegativeInteger(inputs.readEntries) *
    toNonNegativeNumber(config.feePerDiskReadEntry);
  const writeEntries =
    toNonNegativeInteger(inputs.writeEntries) *
    toNonNegativeNumber(config.feePerWriteEntry);
  const diskReadBytes = computeFeePerIncrement(
    inputs.readBytes,
    config.feePerDiskRead1kb,
    DATA_SIZE_1KB_INCREMENT
  );
  const writeBytes = computeFeePerIncrement(
    inputs.writeBytes,
    config.feePerWrite1kb,
    DATA_SIZE_1KB_INCREMENT
  );
  const historical =
    inputs.transactionSizeBytes > 0
      ? computeFeePerIncrement(
          inputs.transactionSizeBytes + TX_BASE_RESULT_SIZE,
          config.feePerHistorical1kb,
          DATA_SIZE_1KB_INCREMENT
        )
      : 0;
  const contractEvents = computeFeePerIncrement(
    inputs.eventsSizeBytes + inputs.returnValueSizeBytes,
    config.feePerContractEvent1kb,
    DATA_SIZE_1KB_INCREMENT
  );
  const transactionSize =
    inputs.transactionSizeBytes > 0
      ? computeFeePerIncrement(
          inputs.transactionSizeBytes,
          config.feePerTransactionSize1kb,
          DATA_SIZE_1KB_INCREMENT
        )
      : 0;
  const memory = computeFeePerIncrement(
    inputs.memoryBytes,
    config.feePerMemory1kb,
    DATA_SIZE_1KB_INCREMENT
  );

  const nonRefundableStroops =
    instructions +
    diskReadEntries +
    writeEntries +
    diskReadBytes +
    writeBytes +
    historical +
    transactionSize +
    memory;
  const refundableStroops = contractEvents;

  return {
    nonRefundableStroops,
    refundableStroops,
    totalStroops: nonRefundableStroops + refundableStroops,
    inputs,
    breakdown: {
      instructions,
      diskReadEntries,
      writeEntries,
      diskReadBytes,
      writeBytes,
      historical,
      contractEvents,
      transactionSize,
      memory,
    },
  };
}

function roundPercentiles(percentiles) {
  return {
    p10: Math.round(percentiles.p10),
    p50: Math.round(percentiles.p50),
    p90: Math.round(percentiles.p90),
    p99: Math.round(percentiles.p99),
  };
}

export function buildFeeRecommendations(
  percentiles,
  operationCount = 1,
  resourceFeeTotal = 0
) {
  const operations = toPositiveInteger(operationCount, 1);
  const resourceFee = toNonNegativeNumber(resourceFeeTotal);

  const tiers = {
    slow: percentiles?.p50 ?? BASE_FEE_STROOPS,
    normal: percentiles?.p90 ?? BASE_FEE_STROOPS,
    urgent: percentiles?.p99 ?? BASE_FEE_STROOPS,
  };

  const recommendations = {};

  for (const [tier, feePerOperation] of Object.entries(tiers)) {
    const feePerOperationStroops = Math.max(
      BASE_FEE_STROOPS,
      Math.round(toNonNegativeNumber(feePerOperation, BASE_FEE_STROOPS))
    );
    const inclusionFeeStroops = feePerOperationStroops * operations;
    const totalFeeStroops = inclusionFeeStroops + resourceFee;

    recommendations[tier] = {
      tier,
      feePerOperationStroops,
      inclusionFeeStroops,
      resourceFeeStroops: resourceFee,
      totalFeeStroops,
      totalFeeXlm: Number((totalFeeStroops / STROOPS_PER_XLM).toFixed(7)),
    };
  }

  return recommendations;
}

function parseFeePerOperation(record) {
  const feeCharged = Number.parseInt(record?.fee_charged, 10);
  if (!Number.isFinite(feeCharged) || feeCharged <= 0) return null;

  const operationCount = Number.parseInt(record?.operation_count, 10);
  const denominator =
    Number.isFinite(operationCount) && operationCount > 0 ? operationCount : 1;

  return feeCharged / denominator;
}

function parseFeeStat(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;

  const fallbackValue = Number.parseInt(fallback, 10);
  return Number.isFinite(fallbackValue) && fallbackValue > 0
    ? fallbackValue
    : BASE_FEE_STROOPS;
}

export class FeeEstimator {
  constructor(options = {}) {
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.redis = options.redis === undefined ? redisService : options.redis;
    this.now = options.now || Date.now;
    this.horizonUrls = buildHorizonUrls(options.horizonUrls);
    this.cacheTtlSeconds = options.cacheTtlSeconds ?? FEE_CACHE_TTL_SECONDS;
    this.ledgerSampleSize = options.ledgerSampleSize ?? LEDGER_SAMPLE_SIZE;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
    this.spikeThresholdRatio =
      options.spikeThresholdRatio ?? FEE_SPIKE_THRESHOLD_RATIO;
    this.feeConfig = {
      ...DEFAULT_FEE_CONFIG,
      ...(options.feeConfig || {}),
    };
    this.logger = options.logger || console;

    this.memoryCache = new Map();
    this.inflightRequests = new Map();
    this.alertListeners = new Set();
    this.lastAlerts = new Map();
    this.emittedAlertKeys = new Set();
  }

  async getEstimate(options = {}) {
    const network = normalizeNetwork(options.network);
    const now = this.now();
    const cached = this.memoryCache.get(network);

    if (cached && cached.expiresAt > now) {
      return this.finalizeEstimate(cached.base, options, true);
    }

    const redisCached = await this.readCachedBase(network);
    if (redisCached) {
      this.storeInMemory(network, redisCached);
      return this.finalizeEstimate(redisCached, options, true);
    }

    const base = await this.getOrComputeBase(network);
    return this.finalizeEstimate(base, options, false);
  }

  getLastAlert(network = 'testnet') {
    try {
      return this.lastAlerts.get(normalizeNetwork(network)) || null;
    } catch {
      return null;
    }
  }

  onAlert(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('alert listener must be a function');
    }
    this.alertListeners.add(listener);
    return () => {
      this.alertListeners.delete(listener);
    };
  }

  reset() {
    this.memoryCache.clear();
    this.inflightRequests.clear();
    this.lastAlerts.clear();
    this.emittedAlertKeys.clear();
  }

  _clearCacheForTesting() {
    this.reset();
  }

  finalizeEstimate(base, options, cached) {
    const resourceFee = computeResourceFee(options, this.feeConfig);
    const operationCount = toPositiveInteger(options.operationCount, 1);
    const recommendations = buildFeeRecommendations(
      base.percentiles,
      operationCount,
      resourceFee.totalStroops
    );

    return {
      network: base.network,
      cached,
      source: base.source,
      degraded: base.degraded,
      generatedAt: base.generatedAt,
      sampleCount: base.sampleCount,
      ledgerRange: base.ledgerRange,
      percentiles: base.percentiles,
      operationCount,
      resourceUsage: resourceFee.inputs,
      resourceFee: {
        nonRefundableStroops: resourceFee.nonRefundableStroops,
        refundableStroops: resourceFee.refundableStroops,
        totalStroops: resourceFee.totalStroops,
        breakdown: resourceFee.breakdown,
      },
      recommendations,
      inclusionFee: {
        slow: recommendations.slow.inclusionFeeStroops,
        normal: recommendations.normal.inclusionFeeStroops,
        urgent: recommendations.urgent.inclusionFeeStroops,
      },
      totalFee: {
        slow: recommendations.slow.totalFeeStroops,
        normal: recommendations.normal.totalFeeStroops,
        urgent: recommendations.urgent.totalFeeStroops,
      },
      alert: base.alert,
      error: base.error,
      perLedger: base.perLedger,
    };
  }

  async getOrComputeBase(network) {
    const existing = this.inflightRequests.get(network);
    if (existing) return existing;

    const request = this.computeBase(network).finally(() => {
      this.inflightRequests.delete(network);
    });

    this.inflightRequests.set(network, request);
    return request;
  }

  async computeBase(network) {
    let base;

    try {
      const ledgerSamples = await this.fetchLedgerSamples(network);
      if (ledgerSamples.length === 0) {
        throw new Error('No recent ledger fee samples available');
      }
      base = this.buildBaseFromLedgers(network, ledgerSamples);
    } catch (ledgerError) {
      try {
        const feeStats = await this.fetchFeeStats(network);
        base = this.buildBaseFromFeeStats(network, feeStats);
      } catch (statsError) {
        base = this.buildFallbackBase(
          network,
          statsError?.message || ledgerError?.message
        );
      }
    }

    this.storeInMemory(network, base);
    await this.writeCachedBase(network, base);
    return base;
  }

  buildBaseFromLedgers(network, ledgerSamples) {
    const allFees = ledgerSamples.flatMap((sample) => sample.fees);
    const percentiles = roundPercentiles(computePercentiles(allFees));

    const perLedger = ledgerSamples
      .map((sample) => ({
        ledger: sample.ledger,
        transactionCount: sample.fees.length,
        medianFeePerOperation: Math.round(calculatePercentile(sample.fees, 50)),
        p90FeePerOperation: Math.round(calculatePercentile(sample.fees, 90)),
      }))
      .sort((a, b) => a.ledger - b.ledger);

    const alerts = this.detectFeeSpikes(perLedger);
    const detectedAlert = alerts.length > 0 ? alerts[alerts.length - 1] : null;
    const alert = detectedAlert
      ? this.notifyAlert(network, detectedAlert)
      : null;

    return {
      network,
      source: 'ledgers',
      degraded: false,
      generatedAt: this.now(),
      sampleCount: allFees.length,
      ledgerRange: {
        fromLedger: perLedger[0]?.ledger ?? null,
        toLedger: perLedger[perLedger.length - 1]?.ledger ?? null,
        ledgerCount: perLedger.length,
      },
      percentiles,
      perLedger,
      alert,
    };
  }

  buildBaseFromFeeStats(network, feeStats) {
    const percentiles = {
      p10: Math.round(feeStats.p10),
      p50: Math.round(feeStats.p50),
      p90: Math.round(feeStats.p90),
      p99: Math.round(feeStats.p99),
    };

    return {
      network,
      source: 'fee_stats',
      degraded: false,
      generatedAt: this.now(),
      sampleCount: 0,
      ledgerRange: {
        fromLedger: feeStats.lastLedger ?? null,
        toLedger: feeStats.lastLedger ?? null,
        ledgerCount: feeStats.lastLedger ? 1 : 0,
      },
      percentiles,
      perLedger: [],
      alert: null,
    };
  }

  buildFallbackBase(network, reason) {
    return {
      network,
      source: 'fallback',
      degraded: true,
      generatedAt: this.now(),
      sampleCount: 0,
      ledgerRange: {
        fromLedger: null,
        toLedger: null,
        ledgerCount: 0,
      },
      percentiles: {
        p10: BASE_FEE_STROOPS,
        p50: BASE_FEE_STROOPS,
        p90: BASE_FEE_STROOPS,
        p99: BASE_FEE_STROOPS,
      },
      perLedger: [],
      alert: null,
      error: reason || 'Fee sampling unavailable',
    };
  }

  detectFeeSpikes(perLedger) {
    const alerts = [];

    for (let index = 1; index < perLedger.length; index += 1) {
      const previous = perLedger[index - 1];
      const current = perLedger[index];

      if (current.ledger !== previous.ledger + 1) continue;
      if (previous.medianFeePerOperation <= 0) continue;

      const changeRatio =
        (current.medianFeePerOperation - previous.medianFeePerOperation) /
        previous.medianFeePerOperation;

      if (Math.abs(changeRatio) <= this.spikeThresholdRatio) continue;

      alerts.push({
        network: undefined,
        fromLedger: previous.ledger,
        toLedger: current.ledger,
        previousMedianFeePerOperation: previous.medianFeePerOperation,
        currentMedianFeePerOperation: current.medianFeePerOperation,
        changePercent: Number((changeRatio * 100).toFixed(2)),
        direction: changeRatio > 0 ? 'increase' : 'decrease',
        thresholdPercent: this.spikeThresholdRatio * 100,
        detectedAt: this.now(),
      });
    }

    return alerts;
  }

  notifyAlert(network, alert) {
    const enriched = { ...alert, network };
    const key = `${network}:${alert.fromLedger}:${alert.toLedger}:${alert.currentMedianFeePerOperation}`;

    if (this.emittedAlertKeys.has(key)) return enriched;
    this.emittedAlertKeys.add(key);
    if (this.emittedAlertKeys.size > 500) {
      const oldest = this.emittedAlertKeys.values().next().value;
      this.emittedAlertKeys.delete(oldest);
    }

    this.lastAlerts.set(network, enriched);

    for (const listener of this.alertListeners) {
      try {
        listener(enriched);
      } catch {
        // Alert listeners must never break fee estimation.
      }
    }

    this.logger.warn?.(
      `[FeeEstimator] Fee spike on ${network}: ${enriched.changePercent}% between ledgers ${alert.fromLedger} and ${alert.toLedger}`
    );

    return enriched;
  }

  async fetchLedgerSamples(network) {
    const horizonUrl = this.horizonUrls[network];
    const ledgerPayload = await this.fetchJson(
      `${horizonUrl}/ledgers?order=desc&limit=${this.ledgerSampleSize}`
    );
    const records = ledgerPayload?._embedded?.records;

    if (!Array.isArray(records) || records.length === 0) return [];

    const samples = await Promise.all(
      records.map(async (record) => {
        const ledger = toNonNegativeInteger(record?.sequence, 0);
        if (ledger <= 0) return { ledger, fees: [] };

        const transactionsUrl = `${horizonUrl}/ledgers/${ledger}/transactions?limit=200&order=asc`;

        try {
          const payload = await this.fetchJson(transactionsUrl);
          const transactions = payload?._embedded?.records || [];
          const fees = transactions
            .map(parseFeePerOperation)
            .filter((fee) => fee !== null);
          return { ledger, fees };
        } catch {
          return { ledger, fees: [] };
        }
      })
    );

    return samples.filter(
      (sample) => sample.ledger > 0 && sample.fees.length > 0
    );
  }

  async fetchFeeStats(network) {
    const horizonUrl = this.horizonUrls[network];
    const payload = await this.fetchJson(`${horizonUrl}/fee_stats`);
    const feeCharged = payload?.fee_charged || payload?.max_fee || {};

    return {
      p10: parseFeeStat(feeCharged.p10, feeCharged.min),
      p50: parseFeeStat(feeCharged.p50, feeCharged.mode),
      p90: parseFeeStat(feeCharged.p90, feeCharged.max),
      p99: parseFeeStat(feeCharged.p99, feeCharged.max),
      lastLedger: Number.parseInt(payload?.last_ledger, 10) || null,
    };
  }

  async fetchJson(url) {
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('fetch implementation is not available');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });

      if (!response?.ok) {
        throw new Error(
          `Horizon HTTP ${response?.status ?? 'unknown'} for ${url}`
        );
      }

      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  storeInMemory(network, base) {
    if (this.cacheTtlSeconds <= 0) return;
    this.memoryCache.set(network, {
      base,
      expiresAt: this.now() + this.cacheTtlSeconds * 1000,
    });
  }

  async readCachedBase(network) {
    if (!this.redis || this.cacheTtlSeconds <= 0) return null;

    try {
      const raw = await this.redis.get(this.cacheKey(network));
      if (raw === null || raw === undefined) return null;

      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (
        !parsed ||
        parsed.network !== network ||
        !parsed.percentiles ||
        !parsed.generatedAt
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  async writeCachedBase(network, base) {
    if (!this.redis || this.cacheTtlSeconds <= 0) return;

    try {
      await this.redis.set(
        this.cacheKey(network),
        JSON.stringify(base),
        this.cacheTtlSeconds
      );
    } catch {
      // Redis is an optional acceleration layer.
    }
  }

  cacheKey(network) {
    return `fee_estimate:${network}`;
  }
}

export const feeEstimator = new FeeEstimator();

export default feeEstimator;
