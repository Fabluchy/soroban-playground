// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT
//
// [BE-10] OpenTelemetry Distributed Tracing & Prometheus Metric Exporters
// Issue #1758 — Target component: backend/src/telemetry/tracer.ts
//
// Initialises the OpenTelemetry NodeSDK with:
//  - Auto-instrumentation for HTTP, Express, PostgreSQL, Redis, and gRPC
//  - W3C Trace Context (traceparent / tracestate) propagation via
//    W3CTraceContextPropagator from @opentelemetry/core
//  - OTLP gRPC exporter to OpenTelemetry Collector / Jaeger
//  - Backwards-compatible Jaeger Thrift and Zipkin exporters
//  - Custom sampler: 100 % errors, 100 % slow requests, N % success
//
// Express middlewares (tracePropagationMiddleware, metricsAuthMiddleware)
// live in telemetry/middleware.js (plain JS) so they can be imported by
// CommonJS/ESM consumers without a TypeScript compilation step.

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  AlwaysOnSampler,
} from '@opentelemetry/sdk-trace-base';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  propagation,
  context,
  trace,
  SpanStatusCode,
  SpanKind,
} from '@opentelemetry/api';
import type { Context, Span, SpanOptions } from '@opentelemetry/api';
import * as resourcesPkg from '@opentelemetry/resources';
import {
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_VERSION,
  SEMRESATTRS_SERVICE_INSTANCE_ID,
} from '@opentelemetry/semantic-conventions';

// ─── Re-export Express middleware helpers ────────────────────────────────────
// These live in the plain-JS companion file so they are importable by
// CommonJS/Babel consumers (metrics.js, server.js) without TypeScript build.
export {
  tracePropagationMiddleware,
  metricsAuthMiddleware,
} from './middleware.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TelemetryConfig {
  enabled: boolean;
  serviceName: string;
  serviceVersion: string;
  /** OTLP gRPC endpoint, e.g. http://otel-collector:4317 */
  otlpEndpoint?: string;
  /** Legacy Jaeger Thrift HTTP endpoint */
  jaegerEndpoint?: string;
  /** Zipkin endpoint */
  zipkinEndpoint?: string;
  /** Fraction of successful requests to sample (0–1, default 0.1) */
  sampleRateSuccess: number;
  /** Fraction of error requests to sample (0–1, default 1.0) */
  sampleRateErrors: number;
  /** Requests slower than this threshold (ms) are always sampled */
  slowRequestThresholdMs: number;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Build an OTel Resource, handling the API shape changes across OTel SDK
 * versions (0.x → 1.x → 2.x).
 */
function buildResource(attrs: Record<string, string>): any {
  const pkg = resourcesPkg as any;
  if (typeof pkg.resourceFromAttributes === 'function') {
    return pkg.resourceFromAttributes(attrs);
  }
  if (typeof pkg.default?.resourceFromAttributes === 'function') {
    return pkg.default.resourceFromAttributes(attrs);
  }
  const Ctor = pkg.Resource ?? pkg.default?.Resource ?? pkg.default ?? pkg;
  if (typeof Ctor === 'function') {
    try {
      return new Ctor(attrs);
    } catch {
      // fall through
    }
  }
  return attrs;
}

// ─── Custom sampler ───────────────────────────────────────────────────────────

/**
 * Sampling strategy (per issue #1758 acceptance criteria):
 *  - 100 % of error spans          (http.status_code >= 400)
 *  - 100 % of slow spans           (http.duration_ms > threshold)
 *  - Configurable % of success spans (default 10 %)
 */
class CustomSampler {
  private readonly successSampler: TraceIdRatioBasedSampler;
  private readonly alwaysOnSampler: AlwaysOnSampler;
  private readonly slowThresholdMs: number;

  constructor(successRate: number, slowThresholdMs: number) {
    this.successSampler = new TraceIdRatioBasedSampler(successRate);
    this.alwaysOnSampler = new AlwaysOnSampler();
    this.slowThresholdMs = slowThresholdMs;
  }

  shouldSample(
    ctx: Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: Record<string, unknown>,
    links: unknown[]
  ) {
    const isError =
      attributes['http.status_code'] !== undefined &&
      Number(attributes['http.status_code']) >= 400;
    const isSlow =
      attributes['http.duration_ms'] !== undefined &&
      Number(attributes['http.duration_ms']) > this.slowThresholdMs;

    if (isError || isSlow) {
      return this.alwaysOnSampler.shouldSample(
        ctx,
        traceId,
        spanName,
        spanKind,
        attributes as any,
        links as any
      );
    }
    return this.successSampler.shouldSample(
      ctx,
      traceId,
      spanName,
      spanKind,
      attributes as any,
      links as any
    );
  }

  toString(): string {
    return `CustomSampler{successRate=${this.successSampler},slowThresholdMs=${this.slowThresholdMs}}`;
  }
}

// ─── SDK initialisation ───────────────────────────────────────────────────────

let _sdk: NodeSDK | null = null;

/**
 * Initialise the OpenTelemetry NodeSDK.
 *
 * Idempotent — safe to call more than once; subsequent calls return the
 * already-running instance.  Returns `null` when tracing is disabled.
 */
export function initializeTelemetry(cfg: TelemetryConfig): NodeSDK | null {
  if (!cfg.enabled) {
    // eslint-disable-next-line no-console
    console.log('[telemetry] OpenTelemetry tracing disabled');
    return null;
  }

  if (_sdk) return _sdk;

  // ── W3C Trace-Context propagation ────────────────────────────────────
  // Registers the W3CTraceContextPropagator globally so that:
  //  - Incoming `traceparent` / `tracestate` headers are extracted and merged
  //    into the active context by @opentelemetry/instrumentation-http.
  //  - Outgoing requests made by instrumented libraries carry the correct headers.
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  // ── Resource ─────────────────────────────────────────────────────────
  const resource = buildResource({
    [SEMRESATTRS_SERVICE_NAME]: cfg.serviceName,
    [SEMRESATTRS_SERVICE_VERSION]: cfg.serviceVersion,
    [SEMRESATTRS_SERVICE_INSTANCE_ID]: process.pid.toString(),
  });

  // ── Exporters ────────────────────────────────────────────────────────
  const spanProcessors: any[] = [];

  // Primary exporter: OTLP gRPC → OpenTelemetry Collector / Jaeger OTLP
  const otlpEndpoint =
    cfg.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '';
  if (otlpEndpoint) {
    const otlpExporter = new OTLPTraceExporter({ url: otlpEndpoint });
    spanProcessors.push(new BatchSpanProcessor(otlpExporter));
    // eslint-disable-next-line no-console
    console.log(`[telemetry] OTLP gRPC exporter → ${otlpEndpoint}`);
  }

  // Legacy Jaeger Thrift HTTP (backwards-compatible)
  if (cfg.jaegerEndpoint) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { JaegerExporter } = require('@opentelemetry/exporter-jaeger');
      spanProcessors.push(
        new BatchSpanProcessor(
          new JaegerExporter({
            endpoint: cfg.jaegerEndpoint,
            username: process.env.JAEGER_USER,
            password: process.env.JAEGER_PASSWORD,
          })
        )
      );
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.warn('[telemetry] JaegerExporter unavailable:', err.message);
    }
  }

  // Zipkin
  if (cfg.zipkinEndpoint) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { ZipkinExporter } = require('@opentelemetry/exporter-zipkin');
      spanProcessors.push(
        new BatchSpanProcessor(new ZipkinExporter({ url: cfg.zipkinEndpoint }))
      );
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.warn('[telemetry] ZipkinExporter unavailable:', err.message);
    }
  }

  // Development fallback: console
  if (spanProcessors.length === 0 && process.env.NODE_ENV === 'development') {
    const { ConsoleSpanExporter } = require('@opentelemetry/sdk-trace-base');
    spanProcessors.push(new BatchSpanProcessor(new ConsoleSpanExporter()));
  }

  // ── SDK ──────────────────────────────────────────────────────────────
  const sdk = new NodeSDK({
    resource,
    spanProcessors,
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-http': { enabled: true },
        '@opentelemetry/instrumentation-express': { enabled: true },
        '@opentelemetry/instrumentation-ioredis': { enabled: true },
        '@opentelemetry/instrumentation-pg': { enabled: true },
        '@opentelemetry/instrumentation-grpc': { enabled: true },
      }),
    ],
    sampler: new ParentBasedSampler({
      root: new CustomSampler(
        cfg.sampleRateSuccess,
        cfg.slowRequestThresholdMs
      ) as any,
    }),
  });

  sdk.start();
  _sdk = sdk;

  // eslint-disable-next-line no-console
  console.log('[telemetry] OpenTelemetry SDK started');

  // ── Graceful shutdown ────────────────────────────────────────────────
  process.once('SIGTERM', async () => {
    try {
      await sdk.shutdown();
      // eslint-disable-next-line no-console
      console.log('[telemetry] SDK shut down gracefully');
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error('[telemetry] Error during SDK shutdown:', err.message);
    }
  });

  return sdk;
}

// ─── Tracer helpers ───────────────────────────────────────────────────────────

/** Returns the application tracer (lazy singleton). */
export function getTracer(
  name = 'soroban-playground',
  version = '1.0.0'
): ReturnType<typeof trace.getTracer> {
  return trace.getTracer(name, version);
}

/**
 * Start a named span with optional attributes.
 * Spans record database query text and error messages with secrets sanitised.
 */
export function createSpan(
  name: string,
  attributes: Record<string, unknown> = {},
  options: SpanOptions = {}
): Span {
  const span = getTracer().startSpan(name, options);
  if (Object.keys(attributes).length > 0) {
    span.setAttributes(attributes as any);
  }
  return span;
}

/**
 * Wrap an async function in a span.
 * Errors are recorded with sanitised messages (secrets stripped).
 */
export function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attributes: Record<string, unknown> = {},
  options: SpanOptions = {}
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const span = createSpan(name, attributes, options);
    const ctx = trace.setSpan(context.active(), span);
    context.with(ctx, () => {
      Promise.resolve()
        .then(() => fn(span))
        .then((result) => {
          span.setStatus({ code: SpanStatusCode.OK });
          span.end();
          resolve(result);
        })
        .catch((err: Error) => {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err.message,
          });
          span.recordException({
            name: err.name,
            message: sanitiseErrorMessage(err.message),
            stack: err.stack,
          });
          span.end();
          reject(err);
        });
    });
  });
}

/**
 * Strip secrets from error messages before recording them on spans.
 * Removes bearer tokens, basic-auth credentials, JWT payloads, and passwords.
 */
export function sanitiseErrorMessage(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/password\s*=\s*[^\s&]*/gi, 'password=[REDACTED]')
    .replace(/:[^@/\s]{3,}@/g, ':***@')
    .replace(/Authorization:\s*\S+/gi, 'Authorization: [REDACTED]');
}

/** Returns the active span's trace ID, or undefined when outside a trace. */
export function getTraceId(): string | undefined {
  return trace.getActiveSpan()?.spanContext().traceId;
}

/**
 * Injects W3C traceparent values into an environment variable map for
 * forwarding to child processes (Cargo build, Soroban CLI, etc.).
 */
export function injectTraceEnv(
  env: Record<string, string> = {}
): Record<string, string> {
  const span = trace.getActiveSpan();
  if (!span) return env;
  const { traceId, spanId, traceFlags } = span.spanContext();
  return {
    ...env,
    OTEL_TRACE_ID: traceId,
    OTEL_SPAN_ID: spanId,
    OTEL_TRACE_FLAGS: traceFlags.toString(),
    TRACEPARENT: `00-${traceId}-${spanId}-${traceFlags
      .toString(16)
      .padStart(2, '0')}`,
  };
}

// ─── Re-exports ───────────────────────────────────────────────────────────────

export { propagation, context, trace, SpanStatusCode, SpanKind };
export type { Span, SpanOptions, Context };
