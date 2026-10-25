// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

import { parentPort, workerData } from 'node:worker_threads';
import { analyzeFiles } from './staticAnalysisEngine.js';

try {
  const result = analyzeFiles(workerData.files, workerData.options || {});
  parentPort?.postMessage({ ok: true, result });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: {
      message: error?.message || String(error),
      code: error?.code || null,
    },
  });
}
