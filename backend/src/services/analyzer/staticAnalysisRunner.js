// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

import { Worker } from 'node:worker_threads';
import {
  analyzeFiles,
  buildSarif,
  normalizeFiles,
} from './staticAnalysisEngine.js';

const DEFAULT_MAX_FILE_TIME_MS = 10_000;
const DEFAULT_MAX_TOTAL_TIME_MS = 30_000;

export class AnalysisTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AnalysisTimeoutError';
    this.code = 'ANALYSIS_TIMEOUT';
    this.statusCode = 408;
  }
}

function workerOptions(options) {
  return {
    maxFiles: options.maxFiles,
    maxFileSizeBytes: options.maxFileSizeBytes,
    maxTotalBytes: options.maxTotalBytes,
    maxFileTimeMs: options.maxFileTimeMs ?? DEFAULT_MAX_FILE_TIME_MS,
    maxTotalTimeMs: options.maxTotalTimeMs ?? DEFAULT_MAX_TOTAL_TIME_MS,
  };
}

export function runSandboxedAnalysis(input, options = {}) {
  const files = normalizeFiles(input, options);
  const perFileTimeMs = options.maxFileTimeMs ?? DEFAULT_MAX_FILE_TIME_MS;
  const maxTotalTimeMs = options.maxTotalTimeMs ?? DEFAULT_MAX_TOTAL_TIME_MS;
  const timeoutMs = Math.min(
    maxTotalTimeMs,
    Math.max(perFileTimeMs, files.length * perFileTimeMs)
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const worker = new Worker(
      new URL('./staticAnalysisWorker.js', import.meta.url),
      {
        workerData: {
          files,
          options: workerOptions(options),
        },
        resourceLimits: {
          maxOldGenerationSizeMb: 128,
          maxYoungGenerationSizeMb: 32,
          stackSizeMb: 4,
        },
      }
    );

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      callback(value);
    };

    timer = setTimeout(() => {
      finish(
        reject,
        new AnalysisTimeoutError(
          `Static analysis exceeded the ${timeoutMs}ms sandbox limit`
        )
      );
    }, timeoutMs);

    worker.once('message', (message) => {
      if (message?.ok) {
        finish(resolve, message.result);
        return;
      }

      const error = new Error(
        message?.error?.message || 'Static analysis failed'
      );
      if (message?.error?.code) error.code = message.error.code;
      finish(reject, error);
    });

    worker.once('error', (error) => {
      finish(reject, error);
    });

    worker.once('exit', (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(
          reject,
          new Error(`Static analysis worker exited with code ${code}`)
        );
        return;
      }
      setImmediate(() => {
        finish(
          reject,
          new Error('Static analysis worker exited without a result')
        );
      });
    });
  });
}

export class StaticAnalysisService {
  constructor(options = {}) {
    this.options = options;
  }

  analyzeSync(input, options = {}) {
    return analyzeFiles(input, { ...this.options, ...options });
  }

  analyze(input, options = {}) {
    const merged = { ...this.options, ...options };
    if (merged.sandbox === false) {
      return Promise.resolve(analyzeFiles(input, merged));
    }
    return runSandboxedAnalysis(input, merged);
  }

  toSarif(result, options = {}) {
    return buildSarif(result, options);
  }
}

export const staticAnalysisService = new StaticAnalysisService();
