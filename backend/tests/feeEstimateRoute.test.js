// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

import express from 'express';
import request from 'supertest';
import { createFeeEstimateRouter } from '../src/routes/v2/feeEstimate.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

function createApp(estimate) {
  const estimator = {
    getEstimate: jest.fn().mockResolvedValue({
      cached: false,
      ...estimate,
    }),
  };
  const app = express();
  app.use(express.json());
  app.use('/api/v2/fee-estimate', createFeeEstimateRouter(estimator));
  app.use(errorHandler);
  return { app, estimator };
}

describe('GET /api/v2/fee-estimate', () => {
  it('returns fee recommendations and parses resource query params', async () => {
    const { app, estimator } = createApp({
      network: 'testnet',
      recommendations: {},
    });

    const res = await request(app).get(
      '/api/v2/fee-estimate?network=testnet&cpuInstructions=20000&readEntries=2'
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.headers['cache-control']).toBe('public, max-age=5');
    expect(res.headers['x-fee-estimate-cache']).toBe('MISS');
    expect(estimator.getEstimate).toHaveBeenCalledWith(
      expect.objectContaining({
        network: 'testnet',
        operationCount: 1,
        cpuInstructions: 20_000,
        readEntries: 2,
      })
    );
  });

  it('rejects unsupported networks', async () => {
    const { app, estimator } = createApp({});

    const res = await request(app).get('/api/v2/fee-estimate?network=devnet');

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Validation failed');
    expect(estimator.getEstimate).not.toHaveBeenCalled();
  });

  it('rejects negative resource values', async () => {
    const { app } = createApp({});

    const res = await request(app).get(
      '/api/v2/fee-estimate?cpuInstructions=-1'
    );

    expect(res.status).toBe(400);
  });
});

describe('POST /api/v2/fee-estimate', () => {
  it('accepts resource usage in the request body', async () => {
    const { app, estimator } = createApp({
      network: 'mainnet',
      recommendations: {},
    });

    const res = await request(app).post('/api/v2/fee-estimate').send({
      network: 'mainnet',
      operationCount: 2,
      cpuInstructions: 20_000,
      memoryBytes: 1_024,
      writeEntries: 1,
      eventsSizeBytes: 1_024,
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(estimator.getEstimate).toHaveBeenCalledWith(
      expect.objectContaining({
        network: 'mainnet',
        operationCount: 2,
        cpuInstructions: 20_000,
        memoryBytes: 1_024,
        writeEntries: 1,
        eventsSizeBytes: 1_024,
      })
    );
  });

  it('marks cached estimates in the response header', async () => {
    const { app } = createApp({
      cached: true,
      recommendations: {},
    });

    const res = await request(app)
      .post('/api/v2/fee-estimate')
      .send({ network: 'testnet' });

    expect(res.status).toBe(200);
    expect(res.headers['x-fee-estimate-cache']).toBe('HIT');
  });
});
