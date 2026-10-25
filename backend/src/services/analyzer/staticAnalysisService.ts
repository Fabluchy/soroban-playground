// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

/**
 * Typed public surface for the Soroban static vulnerability analyzer (#1777).
 *
 * The runtime implementation lives in JavaScript because the production image
 * runs Node 20, which cannot load TypeScript directly. This module re-exports
 * the runtime API and defines the contracts consumed by TypeScript callers.
 */

import { staticAnalysisService } from './staticAnalysisRunner.js';

export {
  SEVERITY,
  SARIF_LEVEL,
  RULES,
  AnalysisInputError,
  normalizeFiles,
  analyzeFiles,
  buildSarif,
  getRule,
} from './staticAnalysisEngine.js';

export {
  AnalysisTimeoutError,
  runSandboxedAnalysis,
  StaticAnalysisService,
  staticAnalysisService,
} from './staticAnalysisRunner.js';

export default staticAnalysisService;

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type SarifLevel = 'error' | 'warning' | 'note';

export interface AnalysisRule {
  id: string;
  name: string;
  severity: Severity;
  level: SarifLevel;
  category: string;
  shortDescription: string;
  fullDescription: string;
  helpUri: string;
  tags: string[];
}

export interface ContractFileInput {
  path: string;
  content: string;
}

export interface StaticAnalysisRequest {
  files?: ContractFileInput[];
  contracts?: Record<string, string>;
  source?: string;
  path?: string;
}

export interface StaticAnalysisOptions {
  maxFiles?: number;
  maxFileSizeBytes?: number;
  maxTotalBytes?: number;
  maxFileTimeMs?: number;
  maxTotalTimeMs?: number;
  sandbox?: boolean;
}

export interface SecurityFinding {
  ruleId: string;
  ruleName: string;
  severity: Severity;
  level: SarifLevel;
  category: string;
  message: string;
  file: string;
  line: number;
  column: number;
  startLine: number;
  endLine: number;
  snippet: string;
  evidence: string | null;
  fingerprint: string;
}

export interface AnalysisSummary {
  total: number;
  bySeverity: Record<Severity, number>;
  byRule: Record<string, number>;
  filesAnalyzed: number;
  durationMs: number;
  truncated: boolean;
}

export interface StaticAnalysisResult {
  findings: SecurityFinding[];
  summary: AnalysisSummary;
  filesAnalyzed: number;
  truncated: boolean;
  durationMs: number;
  completedAt: number;
}

export interface SarifRegion {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  snippet?: { text: string };
}

export interface SarifResult {
  ruleId: string;
  level: SarifLevel;
  message: { text: string };
  locations: Array<{
    physicalLocation: {
      artifactLocation: { uri: string };
      region: SarifRegion;
    };
  }>;
  partialFingerprints: { primaryLocationLineHash: string };
  properties: {
    severity: Severity;
    category: string;
    ruleName: string;
  };
}

export interface SarifLog {
  $schema: string;
  version: '2.1.0';
  runs: Array<{
    tool: {
      driver: {
        name: string;
        version: string;
        informationUri: string;
        rules: Array<Record<string, unknown>>;
      };
    };
    results: SarifResult[];
    invocations: Array<{
      executionSuccessful: boolean;
      endTimeUtc: string;
      toolExecutionNotifications: Array<{
        level: string;
        message: { text: string };
      }>;
    }>;
  }>;
}

export interface SarifOptions {
  toolName?: string;
  toolVersion?: string;
  informationUri?: string;
}
