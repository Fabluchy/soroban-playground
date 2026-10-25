// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT
//
// [BE-10] OpenTelemetry — Express Middleware helpers (Issue #1758)
//
// Plain-JS module so it can be imported by both TypeScript and CommonJS
// consumers (metrics.js, server.js) without requiring a TypeScript build step.
//
// The TypeScript entry-point (tracer.ts) re-exports everything from here.

import { trace } from '@opentelemetry/api';

// ─── tracePropagationMiddleware ───────────────────────────────────────────────

/**
 * Express middleware that:
 *  1. Reads the current OTel trace ID (populated by the W3CTraceContextPropagator
 *     registered in tracer.ts) and exposes it as the `X-Trace-Id` response header
 *     so clients / dashboards can correlate HTTP requests with Jaeger traces.
 *  2. Is intentionally lightweight — actual W3C `traceparent` / `tracestate`
 *     extraction is handled automatically by `@opentelemetry/instrumentation-http`
 *     once `propagation.setGlobalPropagator` is called during SDK init.
 *
 * Telemetry overhead: ~0 ms per request (reads one property from the active context).
 */
export function tracePropagationMiddleware() {
  return function traceContextMiddleware(req, res, next) {
    // Expose the resolved trace ID before calling next so downstream handlers
    // can read `res.getHeader('X-Trace-Id')` if needed.
    const activeSpan = trace.getActiveSpan();
    if (activeSpan) {
      const traceId = activeSpan.spanContext().traceId;
      if (traceId) {
        res.setHeader('X-Trace-Id', traceId);
      }
    }
    next();
  };
}

// ─── metricsAuthMiddleware ─────────────────────────────────────────────────────

/**
 * Express middleware that restricts the `/metrics` endpoint to internal
 * monitoring networks.
 *
 * Configuration:
 *   METRICS_ALLOWED_IPS — comma-separated list of allowed IPv4/IPv6 addresses.
 *   When unset (default) the middleware is a no-op so development environments
 *   work out-of-the-box.
 *
 * Loopback addresses (127.0.0.1, ::1) are always permitted regardless of the
 * allowlist so health checks / local probes never break.
 */
export function metricsAuthMiddleware() {
  return function metricsNetworkGuard(req, res, next) {
    const allowedIps = (process.env.METRICS_ALLOWED_IPS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    // No restriction configured → allow all (useful in dev / CI)
    if (allowedIps.length === 0) return next();

    const clientIp =
      (req.headers['x-forwarded-for'] ?? '').toString().split(',')[0].trim() ||
      req.ip ||
      '';

    // Loopback is always allowed
    const isLoopback =
      clientIp === '127.0.0.1' ||
      clientIp === '::1' ||
      clientIp === '::ffff:127.0.0.1';

    if (isLoopback || allowedIps.includes(clientIp)) {
      return next();
    }

    res.status(403).json({
      error: 'Forbidden: metrics endpoint restricted to internal network',
    });
  };
}
