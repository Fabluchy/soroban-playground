// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

import {
  BASE_FEE_STROOPS,
  FeeEstimator,
  calculatePercentile,
  computePercentiles,
  computeResourceFee,
} from '../src/services/oracle/feeEstimator.js';

function createClock(start = 1_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

function createRedis(clock = { now: Date.now }) {
  const store = new Map();
  return {
    store,
    get: jest.fn(async (key) => {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= clock.now()) {
        store.delete(key);
        return null;
      }
      return entry.value;
    }),
    set: jest.fn(async (key, value, ttl = 5) => {
      store.set(key, {
        value,
        expiresAt: clock.now() + ttl * 1_000,
      });
      return 'OK';
    }),
  };
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  };
}

function makeHorizonFetch({
  ledgers = [],
  transactions = {},
  feeStats = null,
  failLedgers = false,
} = {}) {
  return jest.fn(async (url) => {
    if (url.includes('/ledgers?order=desc')) {
      if (failLedgers) throw new Error('ledger endpoint unavailable');
      return jsonResponse({
        _embedded: { records: ledgers },
      });
    }

    if (url.includes('/fee_stats')) {
      if (!feeStats) throw new Error('fee stats unavailable');
      return jsonResponse(feeStats);
    }

    const match = url.match(/\/ledgers\/(\d+)\/transactions/);
    if (match) {
      const ledger = match[1];
      return jsonResponse({
        _embedded: { records: transactions[ledger] || [] },
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  });
}

function tx(feeCharged, operationCount = 1) {
  return {
    fee_charged: String(feeCharged),
    operation_count: operationCount,
  };
}

describe('fee estimator math', () => {
  it('calculates linear-interpolated percentiles', () => {
    const values = [100, 200, 300, 400];

    expect(calculatePercentile(values, 0)).toBe(100);
    expect(calculatePercentile(values, 25)).toBe(175);
    expect(calculatePercentile(values, 50)).toBe(250);
    expect(calculatePercentile(values, 90)).toBe(370);
    expect(calculatePercentile(values, 100)).toBe(400);
    expect(calculatePercentile([], 50)).toBe(0);
  });

  it('computes 10/50/90/99 fee percentiles', () => {
    expect(computePercentiles([100, 200, 300, 400])).toEqual({
      p10: 130,
      p50: 250,
      p90: 370,
      p99: 397,
    });
  });

  it('matches the Soroban resource fee formula', () => {
    const estimate = computeResourceFee({
      cpuInstructions: 20_000,
      memoryBytes: 1_024,
      readEntries: 2,
      writeEntries: 1,
      readBytes: 2_048,
      writeBytes: 1_024,
      transactionSizeBytes: 1_024,
      eventsSizeBytes: 1_024,
      returnValueSizeBytes: 0,
    });

    expect(estimate.breakdown).toEqual({
      instructions: 200,
      diskReadEntries: 10_000,
      writeEntries: 20_000,
      diskReadBytes: 2_000,
      writeBytes: 3_500,
      historical: 130,
      contractEvents: 200,
      transactionSize: 2_000,
      memory: 0,
    });
    expect(estimate.nonRefundableStroops).toBe(37_830);
    expect(estimate.refundableStroops).toBe(200);
    expect(estimate.totalStroops).toBe(38_030);
  });

  it('charges only the resource components that were provided', () => {
    const estimate = computeResourceFee({
      cpuInstructions: 20_000,
      readEntries: 2,
      writeEntries: 1,
    });

    expect(estimate.breakdown.instructions).toBe(200);
    expect(estimate.breakdown.diskReadEntries).toBe(10_000);
    expect(estimate.breakdown.writeEntries).toBe(20_000);
    expect(estimate.breakdown.historical).toBe(0);
    expect(estimate.breakdown.transactionSize).toBe(0);
    expect(estimate.totalStroops).toBe(30_200);
  });

  it('returns zero fees for empty resource usage', () => {
    const estimate = computeResourceFee({});
    expect(estimate.nonRefundableStroops).toBe(0);
    expect(estimate.refundableStroops).toBe(0);
    expect(estimate.totalStroops).toBe(0);
  });
});

describe('FeeEstimator', () => {
  it('ingests the latest ledgers and returns slow/normal/urgent fees', async () => {
    const fetchImpl = makeHorizonFetch({
      ledgers: [{ sequence: '102' }, { sequence: '101' }],
      transactions: {
        101: [tx(100), tx(200)],
        102: [tx(800), tx(1600)],
      },
    });

    const estimator = new FeeEstimator({
      fetchImpl,
      redis: null,
      now: createClock().now,
      logger: { warn: jest.fn() },
    });

    const estimate = await estimator.getEstimate({ network: 'testnet' });

    expect(estimate.source).toBe('ledgers');
    expect(estimate.cached).toBe(false);
    expect(estimate.degraded).toBe(false);
    expect(estimate.sampleCount).toBe(4);
    expect(estimate.ledgerRange).toEqual({
      fromLedger: 101,
      toLedger: 102,
      ledgerCount: 2,
    });
    expect(estimate.percentiles).toEqual({
      p10: 130,
      p50: 500,
      p90: 1_360,
      p99: 1_576,
    });
    expect(estimate.recommendations.slow.feePerOperationStroops).toBe(500);
    expect(estimate.recommendations.normal.feePerOperationStroops).toBe(1_360);
    expect(estimate.recommendations.urgent.feePerOperationStroops).toBe(1_576);
    expect(estimate.totalFee.slow).toBe(500);
  });

  it('raises an alert when the median fee changes by more than 300%', async () => {
    const fetchImpl = makeHorizonFetch({
      ledgers: [{ sequence: '102' }, { sequence: '101' }],
      transactions: {
        101: [tx(100), tx(200)],
        102: [tx(800), tx(1600)],
      },
    });

    const listener = jest.fn();
    const estimator = new FeeEstimator({
      fetchImpl,
      redis: null,
      now: createClock().now,
      logger: { warn: jest.fn() },
    });
    estimator.onAlert(listener);

    const estimate = await estimator.getEstimate({ network: 'testnet' });

    expect(estimate.alert).toEqual(
      expect.objectContaining({
        network: 'testnet',
        fromLedger: 101,
        toLedger: 102,
        previousMedianFeePerOperation: 150,
        currentMedianFeePerOperation: 1_200,
        changePercent: 700,
        direction: 'increase',
      })
    );
    expect(listener).toHaveBeenCalledTimes(1);
    expect(estimator.getLastAlert('testnet')).toEqual(estimate.alert);
  });

  it('serves repeated requests from the 5-second in-memory cache', async () => {
    const clock = createClock();
    const redis = createRedis(clock);
    const fetchImpl = makeHorizonFetch({
      ledgers: [{ sequence: '101' }],
      transactions: { 101: [tx(100), tx(200)] },
    });

    const estimator = new FeeEstimator({
      fetchImpl,
      redis,
      now: clock.now,
      cacheTtlSeconds: 5,
      logger: { warn: jest.fn() },
    });

    const first = await estimator.getEstimate({ network: 'testnet' });
    const callsAfterFirst = fetchImpl.mock.calls.length;

    const second = await estimator.getEstimate({ network: 'testnet' });

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(callsAfterFirst);
    expect(redis.set).toHaveBeenCalledWith(
      'fee_estimate:testnet',
      expect.any(String),
      5
    );

    clock.advance(5_001);
    await estimator.getEstimate({ network: 'testnet' });
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('reuses the Redis cache across estimator instances', async () => {
    const redis = createRedis();
    const firstFetch = makeHorizonFetch({
      ledgers: [{ sequence: '101' }],
      transactions: { 101: [tx(100), tx(200)] },
    });
    const first = new FeeEstimator({
      fetchImpl: firstFetch,
      redis,
      now: createClock().now,
    });

    await first.getEstimate({ network: 'testnet' });

    const failingFetch = jest.fn(async () => {
      throw new Error('Horizon unavailable');
    });
    const second = new FeeEstimator({
      fetchImpl: failingFetch,
      redis,
      now: createClock().now,
    });

    const estimate = await second.getEstimate({ network: 'testnet' });

    expect(estimate.cached).toBe(true);
    expect(estimate.source).toBe('ledgers');
    expect(failingFetch).not.toHaveBeenCalled();
  });

  it('falls back to Horizon fee_stats when ledger ingestion fails', async () => {
    const fetchImpl = makeHorizonFetch({
      failLedgers: true,
      feeStats: {
        last_ledger: '500',
        fee_charged: {
          p10: '100',
          p50: '200',
          p90: '300',
          p99: '400',
        },
      },
    });

    const estimator = new FeeEstimator({
      fetchImpl,
      redis: null,
      now: createClock().now,
    });
    const estimate = await estimator.getEstimate({ network: 'mainnet' });

    expect(estimate.source).toBe('fee_stats');
    expect(estimate.degraded).toBe(false);
    expect(estimate.percentiles).toEqual({
      p10: 100,
      p50: 200,
      p90: 300,
      p99: 400,
    });
    expect(estimate.recommendations.normal.feePerOperationStroops).toBe(300);
  });

  it('returns base-fee recommendations when all Horizon calls fail', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error('network down');
    });
    const estimator = new FeeEstimator({
      fetchImpl,
      redis: null,
      now: createClock().now,
    });

    const estimate = await estimator.getEstimate({ network: 'testnet' });

    expect(estimate.source).toBe('fallback');
    expect(estimate.degraded).toBe(true);
    expect(estimate.error).toMatch(/network down/);
    expect(estimate.percentiles).toEqual({
      p10: BASE_FEE_STROOPS,
      p50: BASE_FEE_STROOPS,
      p90: BASE_FEE_STROOPS,
      p99: BASE_FEE_STROOPS,
    });
    expect(estimate.recommendations.urgent.totalFeeStroops).toBe(
      BASE_FEE_STROOPS
    );
  });

  it('adds the resource fee to every recommendation tier', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error('offline');
    });
    const estimator = new FeeEstimator({
      fetchImpl,
      redis: null,
      now: createClock().now,
    });

    const estimate = await estimator.getEstimate({
      network: 'testnet',
      operationCount: 2,
      cpuInstructions: 20_000,
      readEntries: 2,
      writeEntries: 1,
      readBytes: 2_048,
      writeBytes: 1_024,
      transactionSizeBytes: 1_024,
      eventsSizeBytes: 1_024,
    });

    expect(estimate.resourceFee.totalStroops).toBe(38_030);
    expect(estimate.recommendations.slow.inclusionFeeStroops).toBe(200);
    expect(estimate.recommendations.slow.totalFeeStroops).toBe(38_230);
    expect(estimate.recommendations.urgent.totalFeeStroops).toBe(38_230);
  });
});
