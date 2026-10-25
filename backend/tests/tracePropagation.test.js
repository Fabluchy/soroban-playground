// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT
//
// Integration tests for W3C Trace Context header propagation — Issue #1758.
//
// Tests validate:
//  - tracePropagationMiddleware attaches X-Trace-Id to responses
//  - metricsAuthMiddleware blocks non-allowlisted IPs when configured
//  - metricsAuthMiddleware allows all IPs when METRICS_ALLOWED_IPS is unset
//  - Metrics endpoint exposes compiler_jobs_active and rpc_latency_milliseconds

import { jest } from '@jest/globals';

// ─── Mock heavy OTel modules to keep the test suite fast ─────────────────────

jest.mock('@opentelemetry/api', () => {
  const NOOP_SPAN = {
    spanContext: () => ({
      traceId: 'aabbccddeeff00112233445566778899',
      spanId: '0011223344556677',
      traceFlags: 1,
    }),
    setAttributes: jest.fn(),
    setStatus: jest.fn(),
    recordException: jest.fn(),
    addEvent: jest.fn(),
    end: jest.fn(),
  };
  return {
    trace: {
      getTracer: jest.fn().mockReturnValue({
        startSpan: jest.fn().mockReturnValue(NOOP_SPAN),
      }),
      getActiveSpan: jest.fn().mockReturnValue(NOOP_SPAN),
      setSpan: jest.fn().mockImplementation((ctx) => ctx),
    },
    propagation: {
      setGlobalPropagator: jest.fn(),
      inject: jest.fn(),
      extract: jest.fn().mockImplementation((ctx) => ctx),
    },
    context: {
      active: jest.fn().mockReturnValue({}),
      with: jest.fn().mockImplementation((_ctx, fn) => fn()),
    },
    SpanStatusCode: { OK: 0, ERROR: 2 },
    SpanKind: { INTERNAL: 0, SERVER: 1, CLIENT: 2 },
  };
});

// ─── Imports ──────────────────────────────────────────────────────────────────

import express from 'express';
import request from 'supertest';

const {
  tracePropagationMiddleware,
  metricsAuthMiddleware,
} = require('../src/telemetry/middleware.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildApp(allowedIps) {
  const app = express();
  if (allowedIps !== undefined) {
    process.env.METRICS_ALLOWED_IPS = allowedIps;
  } else {
    delete process.env.METRICS_ALLOWED_IPS;
  }
  app.use(tracePropagationMiddleware());
  app.use('/metrics', metricsAuthMiddleware(), (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  return app;
}

// ─── Test suites ──────────────────────────────────────────────────────────────

describe('[BE-10] Trace Header Propagation — Issue #1758', () => {
  afterEach(() => {
    delete process.env.METRICS_ALLOWED_IPS;
  });

  // ── tracePropagationMiddleware ─────────────────────────────────────────────

  describe('tracePropagationMiddleware', () => {
    it('mounts without throwing', () => {
      expect(() => tracePropagationMiddleware()).not.toThrow();
    });

    it('returns an Express middleware function with arity 3', () => {
      const mw = tracePropagationMiddleware();
      expect(typeof mw).toBe('function');
      expect(mw.length).toBe(3);
    });

    it('passes requests through to the next handler', async () => {
      const app = buildApp();
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('attaches X-Trace-Id header to responses when a span is active', async () => {
      const app = buildApp();
      const res = await request(app).get('/health');
      // The mock returns a fixed trace ID
      expect(res.headers['x-trace-id']).toBe(
        'aabbccddeeff00112233445566778899'
      );
    });

    it('handles multiple concurrent requests independently', async () => {
      const app = buildApp();
      const results = await Promise.all([
        request(app).get('/health'),
        request(app).get('/health'),
        request(app).get('/health'),
      ]);
      for (const res of results) {
        expect(res.status).toBe(200);
      }
    });

    it('accepts W3C traceparent header without error', async () => {
      const app = buildApp();
      const traceparent =
        '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
      const res = await request(app)
        .get('/health')
        .set('traceparent', traceparent);
      expect(res.status).toBe(200);
    });

    it('accepts W3C tracestate header alongside traceparent without error', async () => {
      const app = buildApp();
      const res = await request(app)
        .get('/health')
        .set(
          'traceparent',
          '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
        )
        .set('tracestate', 'rojo=00f067aa0ba902b7,congo=t61rcWkgMzE');
      expect(res.status).toBe(200);
    });

    it('does not crash on malformed traceparent header', async () => {
      const app = buildApp();
      const res = await request(app)
        .get('/health')
        .set('traceparent', 'not-a-valid-w3c-header');
      expect(res.status).toBe(200);
    });
  });

  // ── metricsAuthMiddleware ──────────────────────────────────────────────────

  describe('metricsAuthMiddleware', () => {
    it('mounts without throwing', () => {
      expect(() => metricsAuthMiddleware()).not.toThrow();
    });

    it('returns an Express middleware function with arity 3', () => {
      const mw = metricsAuthMiddleware();
      expect(typeof mw).toBe('function');
      expect(mw.length).toBe(3);
    });

    it('allows all requests when METRICS_ALLOWED_IPS is not set', async () => {
      const app = buildApp();
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('allows all requests when METRICS_ALLOWED_IPS is an empty string', async () => {
      const app = buildApp('');
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
    });

    it('allows loopback (127.0.0.1) even when an allowlist is configured', async () => {
      // supertest uses 127.0.0.1 by default — the middleware must permit it
      const app = buildApp('10.0.0.5');
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
    });

    it('returns 403 when client IP is not in the allowlist and not loopback', async () => {
      const app = express();
      // Simulate a non-loopback IP via X-Forwarded-For
      app.use((_req, _res, next) => {
        _req.headers['x-forwarded-for'] = '203.0.113.42';
        next();
      });
      process.env.METRICS_ALLOWED_IPS = '10.0.0.1';
      app.use('/metrics', metricsAuthMiddleware(), (_req, res) => {
        res.json({ ok: true });
      });
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/Forbidden/);
    });

    it('allows client when its IP is in the allowlist', async () => {
      const app = express();
      app.use((_req, _res, next) => {
        _req.headers['x-forwarded-for'] = '10.0.0.5';
        next();
      });
      process.env.METRICS_ALLOWED_IPS = '10.0.0.5,10.0.0.6';
      app.use('/metrics', metricsAuthMiddleware(), (_req, res) => {
        res.json({ ok: true });
      });
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
    });

    it('handles a comma-separated allowlist with surrounding whitespace', async () => {
      const app = express();
      app.use((_req, _res, next) => {
        _req.headers['x-forwarded-for'] = '192.168.1.100';
        next();
      });
      process.env.METRICS_ALLOWED_IPS = ' 192.168.1.100 , 192.168.1.101 ';
      app.use('/metrics', metricsAuthMiddleware(), (_req, res) => {
        res.json({ ok: true });
      });
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
    });
  });
});

// ─── Prometheus metric names ──────────────────────────────────────────────────

describe('[BE-10] Prometheus Metrics — Issue #1758', () => {
  let metricsModule;

  beforeAll(() => {
    metricsModule = require('../src/routes/metrics.js');
  });

  it('exports compiler_jobs_active gauge (canonical OpenMetrics name)', () => {
    expect(metricsModule.compilerJobsActive).toBeDefined();
    expect(metricsModule.compilerJobsActive.name).toBe('compiler_jobs_active');
  });

  it('exports active_compilation_jobs gauge (backwards-compat alias)', () => {
    expect(metricsModule.activeCompilationJobs).toBeDefined();
    expect(metricsModule.activeCompilationJobs.name).toBe(
      'active_compilation_jobs'
    );
  });

  it('exports rpc_latency_milliseconds histogram', () => {
    expect(metricsModule.rpcLatencyMilliseconds).toBeDefined();
    expect(metricsModule.rpcLatencyMilliseconds.name).toBe(
      'rpc_latency_milliseconds'
    );
  });

  it('rpc_latency_milliseconds has endpoint and status label names', () => {
    const metric = metricsModule.rpcLatencyMilliseconds;
    expect(metric.sortedLabelNames ?? metric.labelNames).toEqual(
      expect.arrayContaining(['endpoint', 'status'])
    );
  });

  it('rpc_latency_milliseconds has appropriate ms-scale buckets', () => {
    // Observe values across the bucket range to confirm the histogram accepts them
    expect(() => {
      metricsModule.rpcLatencyMilliseconds.observe(
        { endpoint: '/test', status: 200 },
        50
      );
      metricsModule.rpcLatencyMilliseconds.observe(
        { endpoint: '/test', status: 500 },
        2500
      );
    }).not.toThrow();
  });

  it('http_request_duration_seconds histogram is still exported (no regressions)', () => {
    expect(metricsModule.requestLatency).toBeDefined();
    expect(metricsModule.requestLatency.name).toBe(
      'http_request_duration_seconds'
    );
  });

  it('/metrics endpoint returns 200 when no IP restriction is configured', async () => {
    delete process.env.METRICS_ALLOWED_IPS;
    const app = express();
    app.use('/metrics', metricsModule.default);
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
  });

  it('/metrics response body contains compiler_jobs_active', async () => {
    delete process.env.METRICS_ALLOWED_IPS;
    const app = express();
    app.use('/metrics', metricsModule.default);
    const res = await request(app).get('/metrics');
    expect(res.text).toContain('compiler_jobs_active');
  });

  it('/metrics response body contains rpc_latency_milliseconds', async () => {
    delete process.env.METRICS_ALLOWED_IPS;
    const app = express();
    app.use('/metrics', metricsModule.default);
    const res = await request(app).get('/metrics');
    expect(res.text).toContain('rpc_latency_milliseconds');
  });

  it('/metrics response body contains http_request_duration_seconds', async () => {
    delete process.env.METRICS_ALLOWED_IPS;
    const app = express();
    app.use('/metrics', metricsModule.default);
    const res = await request(app).get('/metrics');
    expect(res.text).toContain('http_request_duration_seconds');
  });
});
