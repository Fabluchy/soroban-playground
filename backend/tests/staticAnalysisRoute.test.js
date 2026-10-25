// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

import express from 'express';
import request from 'supertest';
import { createStaticAnalysisRouter } from '../src/routes/v2/staticAnalysis.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

const sarif = {
  $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
  version: '2.1.0',
  runs: [{ tool: { driver: { name: 'test', rules: [] } }, results: [] }],
};

const analysisResult = {
  findings: [
    {
      ruleId: 'soroban/unverified-address-auth',
      line: 8,
      column: 5,
      severity: 'high',
    },
  ],
  summary: {
    total: 1,
    bySeverity: { critical: 0, high: 1, medium: 0, low: 0 },
    byRule: { 'soroban/unverified-address-auth': 1 },
    filesAnalyzed: 1,
    durationMs: 12,
    truncated: false,
  },
  filesAnalyzed: 1,
  truncated: false,
  durationMs: 12,
  completedAt: Date.now(),
};

function createApp() {
  const analyzer = {
    analyze: jest.fn().mockResolvedValue(analysisResult),
    toSarif: jest.fn().mockReturnValue(sarif),
  };
  const app = express();
  app.use(express.json());
  app.use('/api/v2/analyze/static', createStaticAnalysisRouter(analyzer));
  app.use(errorHandler);
  return { app, analyzer };
}

describe('POST /api/v2/analyze/static', () => {
  it('analyzes a source string and returns findings plus SARIF', async () => {
    const { app, analyzer } = createApp();

    const res = await request(app)
      .post('/api/v2/analyze/static')
      .send({ source: 'pub fn test() {}', path: 'src/lib.rs' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.findings).toHaveLength(1);
    expect(res.body.data.sarif.version).toBe('2.1.0');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(analyzer.analyze).toHaveBeenCalledWith(
      { source: 'pub fn test() {}', path: 'src/lib.rs' },
      {
        sandbox: undefined,
        maxFileTimeMs: undefined,
        maxTotalTimeMs: undefined,
      }
    );
  });

  it('returns raw SARIF when requested', async () => {
    const { app } = createApp();

    const res = await request(app)
      .post('/api/v2/analyze/static')
      .send({
        files: [{ path: 'src/lib.rs', content: 'pub fn test() {}' }],
        format: 'sarif',
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/sarif+json');
    expect(res.body.version).toBe('2.1.0');
  });

  it('accepts resource limits and sandbox options', async () => {
    const { app, analyzer } = createApp();

    await request(app)
      .post('/api/v2/analyze/static')
      .send({
        files: [{ path: 'src/lib.rs', content: 'pub fn test() {}' }],
        sandbox: false,
        maxFileTimeMs: 1000,
        maxTotalTimeMs: 2000,
      });

    expect(analyzer.analyze).toHaveBeenCalledWith(
      {
        files: [{ path: 'src/lib.rs', content: 'pub fn test() {}' }],
      },
      {
        sandbox: false,
        maxFileTimeMs: 1000,
        maxTotalTimeMs: 2000,
      }
    );
  });

  it('rejects an empty analysis request', async () => {
    const { app, analyzer } = createApp();

    const res = await request(app).post('/api/v2/analyze/static').send({});

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Validation failed');
    expect(analyzer.analyze).not.toHaveBeenCalled();
  });

  it('rejects malformed file entries', async () => {
    const { app } = createApp();

    const res = await request(app)
      .post('/api/v2/analyze/static')
      .send({ files: [{ path: 'src/lib.rs' }] });

    expect(res.status).toBe(400);
  });
});

describe('GET /api/v2/analyze/static/rules', () => {
  it('lists the supported Soroban rules', async () => {
    const { app } = createApp();

    const res = await request(app).get('/api/v2/analyze/static/rules');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(
      res.body.data.some(
        (rule) => rule.id === 'soroban/unverified-address-auth'
      )
    ).toBe(true);
  });
});
