// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

export const SEVERITY = Object.freeze({
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
});

export const SARIF_LEVEL = Object.freeze({
  [SEVERITY.CRITICAL]: 'error',
  [SEVERITY.HIGH]: 'error',
  [SEVERITY.MEDIUM]: 'warning',
  [SEVERITY.LOW]: 'note',
});

export const RULES = Object.freeze([
  {
    id: 'soroban/unverified-address-auth',
    name: 'UnverifiedAddressAuthorization',
    severity: SEVERITY.HIGH,
    level: 'error',
    category: 'security',
    shortDescription: 'Address parameter mutates state without require_auth()',
    fullDescription:
      'A Soroban entry point accepts an Address parameter and performs a storage mutation, token operation, or cross-contract invocation without calling require_auth() on any address.',
    helpUri: 'https://developers.stellar.org/docs/learn/security/authorization',
    tags: ['security', 'soroban', 'authorization'],
  },
  {
    id: 'soroban/missing-ttl-renewal',
    name: 'MissingTtlRenewal',
    severity: SEVERITY.MEDIUM,
    level: 'warning',
    category: 'reliability',
    shortDescription:
      'Persistent or temporary storage is written without TTL renewal',
    fullDescription:
      'The contract writes directly to persistent or temporary storage but never calls extend_ttl() in the file, so the entry can be archived before it is read again.',
    helpUri:
      'https://developers.stellar.org/docs/learn/fundamentals/contract-development/storage/state-archival',
    tags: ['reliability', 'soroban', 'storage', 'ttl'],
  },
  {
    id: 'soroban/integer-truncation',
    name: 'IntegerTruncation',
    severity: SEVERITY.HIGH,
    level: 'error',
    category: 'security',
    shortDescription: 'Large integer is cast to a narrower type',
    fullDescription:
      'An i128 or u128 value is cast with the Rust `as` operator to a narrower integer type, which can silently truncate funds or balances.',
    helpUri:
      'https://doc.rust-lang.org/reference/expressions/operator-expr.html',
    tags: ['security', 'soroban', 'integer', 'truncation'],
  },
  {
    id: 'soroban/reentrancy-risk',
    name: 'ReentrancyRisk',
    severity: SEVERITY.MEDIUM,
    level: 'warning',
    category: 'security',
    shortDescription:
      'Cross-contract invocation is followed by a storage write',
    fullDescription:
      'A contract invokes another contract and then writes storage without an authorization or reentrancy guard, which can expose the entry point to reentrancy.',
    helpUri:
      'https://developers.stellar.org/docs/learn/security/contract-security',
    tags: ['security', 'soroban', 'reentrancy'],
  },
]);

const RULE_BY_ID = new Map(RULES.map((rule) => [rule.id, rule]));

const DEFAULT_MAX_FILES = 50;
const DEFAULT_MAX_FILE_SIZE_BYTES = 1_000_000;
const DEFAULT_MAX_TOTAL_BYTES = 5_000_000;
const DEFAULT_MAX_FILE_TIME_MS = 10_000;
const DEFAULT_MAX_TOTAL_TIME_MS = 30_000;

const STORAGE_WRITE_PATTERN =
  /\.\s*(?:persistent|temporary)\s*\(\s*\)\s*\.\s*(?:set|remove)\s*\(/g;
const STORAGE_SET_PATTERN =
  /\.\s*(?:persistent|temporary)\s*\(\s*\)\s*\.\s*set\s*\(/g;
const REQUIRE_AUTH_PATTERN = /\.\s*require_auth(?:_for_args)?\s*\(/g;
const INVOKE_CONTRACT_PATTERN = /\benv\s*\.\s*invoke_contract\s*\(/g;
const TOKEN_MUTATION_PATTERN =
  /\b(?:transfer|transfer_from|mint|burn|approve)\s*\(/g;
const TTL_RENEWAL_PATTERN = /\.\s*extend_ttl\s*\(/;
const FUNCTION_PATTERN =
  /(?:^|\n)[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*(?:<[^>{}]*>)?\s*\(/g;
const CAST_PATTERN =
  /\b([A-Za-z_]\w*)\s+as\s+(i8|i16|i32|i64|u8|u16|u32|u64)\b/g;

export class AnalysisInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AnalysisInputError';
    this.code = 'INVALID_ANALYSIS_INPUT';
    this.statusCode = 400;
  }
}

function maskRustSource(source) {
  const chars = source.split('');
  const length = source.length;
  let index = 0;

  const maskRange = (start, end) => {
    for (let i = start; i < end && i < length; i += 1) {
      if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
    }
  };

  while (index < length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      const stop = end === -1 ? length : end;
      maskRange(index, stop);
      index = stop;
      continue;
    }

    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? length : end + 2;
      maskRange(index, stop);
      index = stop;
      continue;
    }

    if (char === 'r' && (next === '"' || next === '#')) {
      let hashes = 0;
      let cursor = index + 1;
      while (source[cursor] === '#') {
        hashes += 1;
        cursor += 1;
      }
      if (source[cursor] === '"') {
        const terminator = `"${'#'.repeat(hashes)}`;
        const end = source.indexOf(terminator, cursor + 1);
        const stop = end === -1 ? length : end + terminator.length;
        maskRange(index, stop);
        index = stop;
        continue;
      }
    }

    if (char === '"') {
      let cursor = index + 1;
      while (cursor < length) {
        if (source[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        if (source[cursor] === '"') {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      maskRange(index, cursor);
      index = cursor;
      continue;
    }

    if (char === "'") {
      const isCharLiteral =
        source[index + 1] === '\\' ||
        (source[index + 1] !== undefined && source[index + 2] === "'");
      if (isCharLiteral) {
        let cursor = index + 1;
        while (cursor < length) {
          if (source[cursor] === '\\') {
            cursor += 2;
            continue;
          }
          if (source[cursor] === "'") {
            cursor += 1;
            break;
          }
          cursor += 1;
        }
        maskRange(index, cursor);
        index = cursor;
        continue;
      }
    }

    index += 1;
  }

  return chars.join('');
}

function maskTestModules(maskedSource) {
  const match = maskedSource.match(/#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/);
  if (!match || match.index === undefined) return maskedSource;

  const suffix = maskedSource.slice(match.index).replace(/[^\n\r]/g, ' ');
  return maskedSource.slice(0, match.index) + suffix;
}

function findMatching(source, start, openChar, closeChar) {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === openChar) depth += 1;
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function findNext(source, start, target) {
  const index = source.indexOf(target, start);
  if (index === -1) return -1;
  const between = source.slice(start, index);
  if (between.includes(';')) return -1;
  return index;
}

function lineColumnAt(source, index) {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === '\n') {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: index - lineStart + 1 };
}

function snippetFor(lines, line, radius = 2) {
  const start = Math.max(1, line - radius);
  const end = Math.min(lines.length, line + radius);
  return {
    startLine: start,
    endLine: end,
    text: lines.slice(start - 1, end).join('\n'),
  };
}

function parseParameters(paramsText) {
  const parts = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < paramsText.length; index += 1) {
    const char = paramsText[index];
    if ('<({['.includes(char)) depth += 1;
    if ('>)}]'.includes(char)) depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(paramsText.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(paramsText.slice(start));

  const params = [];
  for (const rawPart of parts) {
    const part = rawPart.replace(/#\s*\[[^\]]*\]/g, '').trim();
    if (!part) continue;

    const match = part.match(/^(?:mut\s+)?([A-Za-z_]\w*)\s*:\s*([\s\S]+)$/);
    if (!match) continue;

    const name = match[1];
    const type = match[2].trim();
    params.push({
      name,
      type,
      isAddress: /\bAddress\b/.test(type),
      isLargeInteger: /\b(?:i128|u128)\b/.test(type),
    });
  }

  return params;
}

function extractFunctions(maskedSource) {
  const functions = [];
  FUNCTION_PATTERN.lastIndex = 0;
  let match = FUNCTION_PATTERN.exec(maskedSource);

  while (match) {
    const name = match[1];
    const nameIndex = match.index + match[0].indexOf('fn') + 2;
    const openParen = maskedSource.indexOf(
      '(',
      match.index + match[0].length - 1
    );
    const paramsEnd = findMatching(maskedSource, openParen, '(', ')');

    if (openParen !== -1 && paramsEnd !== -1) {
      const openBrace = findNext(maskedSource, paramsEnd + 1, '{');
      if (openBrace !== -1) {
        const closeBrace = findMatching(maskedSource, openBrace, '{', '}');
        if (closeBrace !== -1) {
          const paramsText = maskedSource.slice(openParen + 1, paramsEnd);
          const body = maskedSource.slice(openBrace + 1, closeBrace);
          const position = lineColumnAt(maskedSource, nameIndex);

          functions.push({
            name,
            params: parseParameters(paramsText),
            body,
            bodyStart: openBrace + 1,
            line: position.line,
            column: position.column,
          });

          FUNCTION_PATTERN.lastIndex = closeBrace;
        }
      }
    }

    match = FUNCTION_PATTERN.exec(maskedSource);
  }

  return functions;
}

function collectLargeIntegerVariables(body, params) {
  const variables = new Set(
    params.filter((param) => param.isLargeInteger).map((param) => param.name)
  );

  const declarationPattern =
    /\blet\s+(?:mut\s+)?([A-Za-z_]\w*)\s*:\s*[^=;]*(?:i128|u128)[^=;]*=/g;
  let match = declarationPattern.exec(body);
  while (match) {
    variables.add(match[1]);
    match = declarationPattern.exec(body);
  }

  return variables;
}

function firstMatchIndex(pattern, source) {
  pattern.lastIndex = 0;
  const match = pattern.exec(source);
  return match && typeof match.index === 'number' ? match.index : -1;
}

function hasMatch(pattern, source) {
  return firstMatchIndex(pattern, source) !== -1;
}

function makeFinding({
  ruleId,
  file,
  source,
  lines,
  index,
  message,
  evidence,
}) {
  const rule = RULE_BY_ID.get(ruleId);
  const { line, column } = lineColumnAt(source, Math.max(0, index));
  const snippet = snippetFor(lines, line);
  const fingerprintSource = `${ruleId}:${file.path}:${line}:${column}:${snippet.text}`;
  let hash = 5381;
  for (let i = 0; i < fingerprintSource.length; i += 1) {
    hash = (hash * 33) ^ fingerprintSource.charCodeAt(i);
  }

  return {
    ruleId,
    ruleName: rule?.name || ruleId,
    severity: rule?.severity || SEVERITY.MEDIUM,
    level: rule?.level || 'warning',
    category: rule?.category || 'security',
    message,
    file: file.path,
    line,
    column,
    startLine: snippet.startLine,
    endLine: snippet.endLine,
    snippet: snippet.text,
    evidence: evidence || null,
    fingerprint: (hash >>> 0).toString(16),
  };
}

function analyzeFunction(file, source, lines, fn, fileHasTtlRenewal) {
  const findings = [];
  const addressParams = fn.params.filter((param) => param.isAddress);
  const body = fn.body;
  const bodyOffset = fn.bodyStart;
  const requireAuth = hasMatch(REQUIRE_AUTH_PATTERN, body);
  const storageWriteIndex = firstMatchIndex(STORAGE_WRITE_PATTERN, body);
  const storageSetIndex = firstMatchIndex(STORAGE_SET_PATTERN, body);
  const invokeIndex = firstMatchIndex(INVOKE_CONTRACT_PATTERN, body);
  const tokenMutationIndex = firstMatchIndex(TOKEN_MUTATION_PATTERN, body);

  if (addressParams.length > 0 && !requireAuth) {
    const usedAddress = addressParams.find((param) =>
      new RegExp(`\\b${param.name}\\b`).test(body)
    );
    const mutatesState =
      storageWriteIndex !== -1 ||
      invokeIndex !== -1 ||
      tokenMutationIndex !== -1;

    if (usedAddress && mutatesState) {
      findings.push(
        makeFinding({
          ruleId: 'soroban/unverified-address-auth',
          file,
          source,
          lines,
          index: bodyOffset + Math.max(0, storageWriteIndex),
          message: `Function '${fn.name}' accepts Address '${usedAddress.name}' and mutates state without require_auth().`,
          evidence: usedAddress.name,
        })
      );
    }
  }

  if (
    storageSetIndex !== -1 &&
    !fileHasTtlRenewal &&
    !hasMatch(TTL_RENEWAL_PATTERN, body)
  ) {
    findings.push(
      makeFinding({
        ruleId: 'soroban/missing-ttl-renewal',
        file,
        source,
        lines,
        index: bodyOffset + storageSetIndex,
        message: `Function '${fn.name}' writes persistent/temporary storage without an extend_ttl() renewal in this file.`,
      })
    );
  }

  const largeVariables = collectLargeIntegerVariables(body, fn.params);
  CAST_PATTERN.lastIndex = 0;
  let castMatch = CAST_PATTERN.exec(body);
  while (castMatch) {
    const variable = castMatch[1];
    const targetType = castMatch[2];
    const lineStart = body.lastIndexOf('\n', castMatch.index) + 1;
    const lineEnd = body.indexOf('\n', castMatch.index);
    const castLine = body.slice(
      lineStart,
      lineEnd === -1 ? body.length : lineEnd
    );
    const lineExposesLargeType = /\b(?:i128|u128)\b/.test(castLine);

    if (largeVariables.has(variable) || lineExposesLargeType) {
      findings.push(
        makeFinding({
          ruleId: 'soroban/integer-truncation',
          file,
          source,
          lines,
          index: bodyOffset + castMatch.index,
          message: `Function '${fn.name}' casts '${variable}' to ${targetType}; this can silently truncate large values.`,
          evidence: castMatch[0],
        })
      );
    }

    castMatch = CAST_PATTERN.exec(body);
  }

  if (
    invokeIndex !== -1 &&
    storageWriteIndex > invokeIndex &&
    !requireAuth &&
    !/\b(?:reentrancy|non_reentrant|lock|guard)\b/i.test(body)
  ) {
    findings.push(
      makeFinding({
        ruleId: 'soroban/reentrancy-risk',
        file,
        source,
        lines,
        index: bodyOffset + invokeIndex,
        message: `Function '${fn.name}' invokes another contract and then writes storage without an authorization or reentrancy guard.`,
      })
    );
  }

  return findings;
}

export function normalizeFiles(input, options = {}) {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileSizeBytes =
    options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

  let rawFiles;

  if (Array.isArray(input)) {
    rawFiles = input;
  } else if (input && Array.isArray(input.files)) {
    rawFiles = input.files;
  } else if (
    input &&
    input.contracts &&
    typeof input.contracts === 'object' &&
    !Array.isArray(input.contracts)
  ) {
    rawFiles = Object.entries(input.contracts).map(([path, content]) => ({
      path,
      content,
    }));
  } else if (input && typeof input.source === 'string') {
    rawFiles = [
      {
        path: input.path || 'contract.rs',
        content: input.source,
      },
    ];
  } else {
    throw new AnalysisInputError(
      'Provide files[], contracts{}, or a source string'
    );
  }

  if (rawFiles.length === 0) {
    throw new AnalysisInputError('At least one contract file is required');
  }
  if (rawFiles.length > maxFiles) {
    throw new AnalysisInputError(
      `At most ${maxFiles} files can be analyzed at once`
    );
  }

  let totalBytes = 0;
  const files = rawFiles.map((rawFile, index) => {
    const file =
      typeof rawFile === 'string'
        ? { path: `contract-${index + 1}.rs`, content: rawFile }
        : rawFile || {};

    if (typeof file.path !== 'string' || file.path.trim() === '') {
      throw new AnalysisInputError(`File ${index + 1} is missing a path`);
    }
    if (typeof file.content !== 'string' || file.content.length === 0) {
      throw new AnalysisInputError(
        `File '${file.path}' is missing source content`
      );
    }

    const sizeBytes = Buffer.byteLength(file.content, 'utf8');
    if (sizeBytes > maxFileSizeBytes) {
      throw new AnalysisInputError(
        `File '${file.path}' exceeds the ${maxFileSizeBytes}-byte limit`
      );
    }

    totalBytes += sizeBytes;
    if (totalBytes > maxTotalBytes) {
      throw new AnalysisInputError(
        `Total source size exceeds the ${maxTotalBytes}-byte limit`
      );
    }

    return {
      path: file.path.trim().replace(/\\/g, '/'),
      content: file.content,
      sizeBytes,
    };
  });

  return files;
}

function analyzeFile(file) {
  const lines = file.content.split(/\r?\n/);
  const masked = maskTestModules(maskRustSource(file.content));
  const fileHasTtlRenewal = TTL_RENEWAL_PATTERN.test(masked);
  const functions = extractFunctions(masked);
  const findings = [];

  for (const fn of functions) {
    findings.push(
      ...analyzeFunction(file, masked, lines, fn, fileHasTtlRenewal)
    );
  }

  return findings;
}

function summarize(findings, filesAnalyzed, durationMs, truncated) {
  const bySeverity = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  const byRule = {};

  for (const finding of findings) {
    bySeverity[finding.severity] = (bySeverity[finding.severity] || 0) + 1;
    byRule[finding.ruleId] = (byRule[finding.ruleId] || 0) + 1;
  }

  return {
    total: findings.length,
    bySeverity,
    byRule,
    filesAnalyzed,
    durationMs,
    truncated,
  };
}

function dedupeFindings(findings) {
  const seen = new Set();
  return findings.filter((finding) => {
    const key = `${finding.ruleId}:${finding.file}:${finding.line}:${finding.column}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function analyzeFiles(input, options = {}) {
  const startedAt = Date.now();
  const files = normalizeFiles(input, options);
  const maxFileTimeMs = options.maxFileTimeMs ?? DEFAULT_MAX_FILE_TIME_MS;
  const maxTotalTimeMs = options.maxTotalTimeMs ?? DEFAULT_MAX_TOTAL_TIME_MS;
  const totalBudgetMs = Math.min(
    maxTotalTimeMs,
    Math.max(maxFileTimeMs, files.length * maxFileTimeMs)
  );

  const findings = [];
  let filesAnalyzed = 0;
  let truncated = false;

  for (const file of files) {
    if (Date.now() - startedAt > totalBudgetMs) {
      truncated = true;
      break;
    }

    const fileStartedAt = Date.now();
    findings.push(...analyzeFile(file));
    filesAnalyzed += 1;

    if (Date.now() - fileStartedAt > maxFileTimeMs) {
      truncated = true;
      break;
    }
  }

  const deduped = dedupeFindings(findings).sort((a, b) => {
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    if (a.line !== b.line) return a.line - b.line;
    if (a.column !== b.column) return a.column - b.column;
    return a.ruleId.localeCompare(b.ruleId);
  });

  const durationMs = Date.now() - startedAt;

  return {
    findings: deduped,
    summary: summarize(deduped, filesAnalyzed, durationMs, truncated),
    filesAnalyzed,
    truncated,
    durationMs,
    completedAt: Date.now(),
  };
}

export function buildSarif(result, options = {}) {
  const toolName = options.toolName || 'Soroban Playground Static Analyzer';
  const toolVersion = options.toolVersion || '1.0.0';
  const informationUri =
    options.informationUri ||
    'https://github.com/StellarDevHub/soroban-playground';

  const rules = RULES.map((rule) => ({
    id: rule.id,
    name: rule.name,
    shortDescription: { text: rule.shortDescription },
    fullDescription: { text: rule.fullDescription },
    helpUri: rule.helpUri,
    defaultConfiguration: { level: rule.level },
    properties: {
      tags: rule.tags,
      severity: rule.severity,
      category: rule.category,
    },
  }));

  const results = result.findings.map((finding) => ({
    ruleId: finding.ruleId,
    level: finding.level,
    message: { text: finding.message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: finding.file },
          region: {
            startLine: finding.line,
            startColumn: finding.column,
            endLine: finding.line,
            endColumn: Math.max(
              finding.column + 1,
              finding.column + (finding.evidence?.length || 1)
            ),
            snippet: { text: finding.snippet },
          },
        },
      },
    ],
    partialFingerprints: {
      primaryLocationLineHash: finding.fingerprint,
    },
    properties: {
      severity: finding.severity,
      category: finding.category,
      ruleName: finding.ruleName,
    },
  }));

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: toolName,
            version: toolVersion,
            informationUri,
            rules,
          },
        },
        results,
        invocations: [
          {
            executionSuccessful: !result.truncated,
            endTimeUtc: new Date(result.completedAt).toISOString(),
            toolExecutionNotifications: result.truncated
              ? [
                  {
                    level: 'warning',
                    message: {
                      text: 'Static analysis time budget exceeded before all files were analyzed.',
                    },
                  },
                ]
              : [],
          },
        ],
      },
    ],
  };
}

export function getRule(ruleId) {
  return RULE_BY_ID.get(ruleId) || null;
}
