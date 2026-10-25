// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import * as StellarSdk from '@stellar/stellar-sdk';
const { StrKey } = StellarSdk;
const SorobanRpc = StellarSdk.rpc || StellarSdk.SorobanRpc;
import DatabaseService from './databaseService.js';
import { compileQueued } from './compileService.js';
import { sanitizeDependenciesInput } from '../routes/compile_utils.js';

const CONTRACT_ID_REGEX = /^C[A-Z0-9]{55}$/;
const HASH_REGEX = /^[a-f0-9]{64}$/i;
const DEFAULT_MAX_SOURCE_BYTES = 1024 * 1024;
const DEFAULT_MAX_WASM_BYTES = 20 * 1024 * 1024;
const DEFAULT_NETWORK = 'testnet';
const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';
const TABLE_NAME = 'contract_verification';

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
    id TEXT PRIMARY KEY,
    contract_id TEXT NOT NULL,
    network TEXT NOT NULL,
    source_code TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    dependencies TEXT NOT NULL DEFAULT {}',
    metadata TEXT NOT NULL DEFAULT '{}',
    wasm_hash TEXT,
    on_chain_wasm_hash TEXT,
    status TEXT NOT NULL,
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    verified_at TEXT
  )
`;

export class VerificationError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'VerificationError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function parseJson(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function validatePlainObject(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new VerificationError(
      400,
      'INVALID_INPUT',
      `${field} must be a plain object`
    );
  }
}

export function validateContractId(contractId) {
  if (typeof contractId !== 'string' || !CONTRACT_ID_REGEX.test(contractId)) {
    throw new VerificationError(
      400,
      'INVALID_CONTRACT_ID',
      'contractId must be a valid Stellar contract ID'
    );
  }
  try {
    StrKey.decodeContract(contractId);
  } catch {
    throw new VerificationError(
      400,
      'INVALID_CONTRACT_ID',
      'contractId must contain a valid Stellar contract address checksum'
    );
  }
  return contractId;
}

export function normalizeHash(hash, field = 'hash') {
  if (typeof hash !== 'string' || !HASH_REGEX.test(hash)) {
    throw new VerificationError(
      400,
      'INVALID_HASH',
      `${field} must be a 64-character hexadecimal SHA-256 hash`
    );
  }
  return hash.toLowerCase();
}

export function hashWasm(wasm) {
  if (!Buffer.isBuffer(wasm) && !(wasm instanceof Uint8Array)) {
    throw new VerificationError(
      400,
      'INVALID_WASM',
      'WASM must be a Buffer or Uint8Array'
    );
  }
  return crypto.createHash('sha256').update(wasm).digest('hex');
}

export function hashSource(sourceCode) {
  return crypto.createHash('sha256').update(sourceCode, 'utf8').digest('hex');
}

function validateSource(sourceCode, maxSourceBytes) {
  if (typeof sourceCode !== 'string' || sourceCode.trim().length === 0) {
    throw new VerificationError(
      400,
      'INVALID_SOURCE',
      'sourceCode is required and must not be empty'
    );
  }

  const sourceBytes = Buffer.byteLength(sourceCode, 'utf8');
  if (sourceBytes > maxSourceBytes) {
    throw new VerificationError(
      413,
      'SOURCE_TOO_LARGE',
      `sourceCode exceeds the ${maxSourceBytes} byte limit`,
      { maxSourceBytes, actualBytes: sourceBytes }
    );
  }
}

function validateWasmSize(wasm, maxWasmBytes) {
  if (!Buffer.isBuffer(wasm) && !(wasm instanceof Uint8Array)) {
    throw new VerificationError(
      502,
      'INVALID_WASM_RESPONSE',
      'Soroban RPC returned an invalid WASM value'
    );
  }
  if (wasm.length === 0) {
    throw new VerificationError(400, 'INVALID_WASM', 'WASM must not be empty');
  }
  const wasmHeader = Buffer.from(wasm).subarray(0, 8);
  if (!wasmHeader.equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) {
    throw new VerificationError(
      400,
      'INVALID_WASM',
      'WASM must use the standard WebAssembly binary header'
    );
  }
  if (wasm.length > maxWasmBytes) {
    throw new VerificationError(
      413,
      'WASM_TOO_LARGE',
      `WASM exceeds the ${maxWasmBytes} byte limit`,
      { maxWasmBytes, actualBytes: wasm.length }
    );
  }
}

function mapRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    contractId: row.contract_id,
    network: row.network,
    sourceHash: row.source_hash,
    wasmHash: row.wasm_hash || null,
    onChainWasmHash: row.on_chain_wasm_hash || null,
    status: row.status,
    verified: row.status === 'verified',
    dependencies: parseJson(row.dependencies, {}),
    metadata: parseJson(row.metadata, {}),
    error: row.error_message
      ? {
          code: row.error_code || 'VERIFICATION_FAILED',
          message: row.error_message,
        }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    verifiedAt: row.verified_at || null,
  };
}

function publicRecord(record) {
  return clone(record);
}

function getRpcUrl(network) {
  const envKey = `${String(network)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '_')}_RPC_URL`;
  return process.env[envKey] || process.env.SOROBAN_RPC_URL || DEFAULT_RPC_URL;
}

function errorDetails(error) {
  return {
    code: error?.code || 'VERIFICATION_FAILED',
    message: error?.message || 'Contract verification failed',
  };
}

export class VerifyService {
  constructor(options = {}) {
    this.db = options.db || new DatabaseService();
    this.compile = options.compile || compileQueued;
    this.rpcClientFactory = options.rpcClientFactory;
    this.fetchOnChainWasm = options.fetchOnChainWasm;
    this.readFile = options.readFile || fs.readFile;
    this.now = options.now || nowIso;
    this.maxSourceBytes =
      options.maxSourceBytes ||
      Number.parseInt(
        process.env.VERIFICATION_MAX_SOURCE_BYTES ||
          `${DEFAULT_MAX_SOURCE_BYTES}`,
        10
      );
    this.maxWasmBytes =
      options.maxWasmBytes ||
      Number.parseInt(
        process.env.VERIFICATION_MAX_WASM_BYTES || `${DEFAULT_MAX_WASM_BYTES}`,
        10
      );
    this.tableReady = null;
  }

  async ensureTable() {
    if (!this.tableReady) {
      this.tableReady = (async () => {
        await this.db.connect();
        await this.db.run(CREATE_TABLE_SQL);
        await this.db.run(
          `CREATE INDEX IF NOT EXISTS idx_contract_verification_contract
           ON ${TABLE_NAME} (contract_id, network, updated_at)`
        );
        await this.db.run(
          `CREATE INDEX IF NOT EXISTS idx_contract_verification_status
           ON ${TABLE_NAME} (status, updated_at)`
        );
      })().catch((error) => {
        this.tableReady = null;
        throw new VerificationError(
          500,
          'DATABASE_ERROR',
          `Failed to initialize verification storage: ${error.message}`
        );
      });
    }
    await this.tableReady;
  }

  async insertPending(record) {
    await this.db.run(
      `INSERT INTO ${TABLE_NAME}
       (id, contract_id, network, source_code, source_hash, dependencies, metadata,
        status, created_at, updated_at)
       VALUES (?, , ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.contractId,
        record.network,
        record.sourceCode,
        record.sourceHash,
        JSON.stringify(record.dependencies),
        JSON.stringify(record.metadata),
        'pending',
        record.createdAt,
        record.createdAt,
      ]
    );
  }

  async updateResult(id, result) {
    await this.db.run(
      `UPDATE ${TABLE_NAME}
       SET wasm_hash = ?, on_chain_wasm_hash = ?, status = ?, error_code = ?,
           error_message = ?, updated_at = ?, verified_at = ?
       WHERE id = ?`,
      [
        result.wasmHash || null,
        result.onChainWasmHash || null,
        result.status,
        result.error?.code || null,
        result.error?.message || null,
        result.updatedAt,
        result.verifiedAt || null,
        id,
      ]
    );
  }

  async loadRow(id) {
    const row = await this.db.get(`SELECT * FROM ${TABLE_NAME} WHERE id = ?`, [
      id,
    ]);
    if (!row) {
      throw new VerificationError(
        404,
        'VERIFICATION_NOT_FOUND',
        'Verification record not found'
      );
    }
    return row;
  }

  async readWasm(input) {
    if (input.wasmBase64 !== undefined) {
      if (typeof input.wasmBase64 !== 'string' || !input.wasmBase64.trim()) {
        throw new VerificationError(
          400,
          'INVALID_WASM',
          'wasmBase64 must be a non-empty base64 string'
        );
      }
      const encoded = input.wasmBase64.trim();
      if (
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          encoded
        )
      ) {
        throw new VerificationError(
          400,
          'INVALID_WASM',
          'wasmBase64 is not valid base64'
        );
      }
      const wasm = Buffer.from(encoded, 'base64');
      if (wasm.toString('base64') !== encoded || wasm.length === 0) {
        throw new VerificationError(
          400,
          'INVALID_WASM',
          'wasmBase64 must contain at least one byte'
        );
      }
      return wasm;
    }

    if (input.wasmPath !== undefined) {
      if (typeof input.wasmPath !== 'string' || !input.wasmPath.trim()) {
        throw new VerificationError(
          400,
          'INVALID_WASM_PATH',
          'wasmPath must be a non-empty string'
        );
      }
      const wasmPath = path.resolve(input.wasmPath);
      const allowedRoot = path.resolve(
        process.env.VERIFICATION_ARTIFACT_ROOT || process.cwd()
      );
      const relative = path.relative(allowedRoot, wasmPath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new VerificationError(
          400,
          'INVALID_WASM_PATH',
          'wasmPath must be inside the configured artifact directory'
        );
      }
      return this.readFile(wasmPath);
    }

    return null;
  }

  async getOnChainWasm(contractId, network) {
    if (this.fetchOnChainWasm) {
      return this.fetchOnChainWasm(contractId, network);
    }

    const client = this.rpcClientFactory
      ? await this.rpcClientFactory(network)
      : new SorobanRpc.Server(getRpcUrl(network));

    if (typeof client?.getContractWasmByContractId !== 'function') {
      throw new VerificationError(
        502,
        'RPC_UNSUPPORTED',
        'Configured Soroban RPC client cannot retrieve contract WASM'
      );
    }

    try {
      return await client.getContractWasmByContractId(contractId);
    } catch (error) {
      throw new VerificationError(
        502,
        'RPC_ERROR',
        `Failed to retrieve on-chain contract WASM: ${error.message}`
      );
    }
  }

  async verifyCompiledWasm({
    contractId,
    network,
    sourceCode,
    dependencies,
    metadata,
    wasm,
  }) {
    let compiledWasm = wasm;
    let compileLogs = [];

    if (!compiledWasm) {
      let compileResult;
      try {
        compileResult = await this.compile({
          requestId: `verify-${Date.now()}`,
          code: sourceCode,
          dependencies,
        });
      } catch (error) {
        throw new VerificationError(
          422,
          'COMPILATION_FAILED',
          `Source compilation failed: ${error.message}`
        );
      }

      if (!compileResult?.success || !compileResult.artifact?.path) {
        throw new VerificationError(
          422,
          'COMPILATION_FAILED',
          'Source compilation did not produce a WASM artifact',
          { logs: compileResult?.logs || [] }
        );
      }

      compileLogs = compileResult.logs || [];
      compiledWasm = await this.readFile(compileResult.artifact.path);
    }

    validateWasmSize(compiledWasm, this.maxWasmBytes);
    const localWasmHash = hashWasm(compiledWasm);

    const onChainWasm = await this.getOnChainWasm(contractId, network);
    validateWasmSize(onChainWasm, this.maxWasmBytes);
    const onChainWasmHash = hashWasm(onChainWasm);

    const match = localWasmHash === onChainWasmHash;
    const now = this.now();

    return {
      contractId,
      network,
      sourceHash: hashSource(sourceCode),
      wasmHash: localWasmHash,
      onChainWasmHash,
      match,
      status: match ? 'verified' : 'mismatch',
      error: match
        ? null
        : {
            code: 'WASM_HASH_MISMATCH',
            message: 'Compiled WASM hash does not match the on-chain WASM hash',
          },
      dependencies,
      metadata,
      compileLogs,
      updatedAt: now,
      verifiedAt: match ? now : null,
    };
  }

  async submitVerification(input) {
    const contractId = validateContractId(input.contractId);
    const network = input.network || DEFAULT_NETWORK;
    const sourceCode = input.sourceCode;
    validateSource(sourceCode, this.maxSourceBytes);

    const dependencies = sanitizeDependenciesInput(input.dependencies || {});
    const metadata = input.metadata || {};
    validatePlainObject(metadata, 'metadata');

    await this.ensureTable();

    const id = crypto.randomUUID();
    const createdAt = this.now();
    const record = {
      id,
      contractId,
      network,
      sourceCode,
      sourceHash: hashSource(sourceCode),
      dependencies,
      metadata,
      createdAt,
    };

    await this.insertPending(record);

    try {
      const wasm = await this.readWasm(input);
      const result = await this.verifyCompiledWasm({
        contractId,
        network,
        sourceCode,
        dependencies,
        metadata,
        wasm,
      });
      await this.updateResult(id, result);
      return publicRecord({ ...record, ...result, id });
    } catch (error) {
      const details = errorDetails(error);
      await this.updateResult(id, {
        status: 'failed',
        error: details,
        updatedAt: this.now(),
      });
      if (error instanceof VerificationError) throw error;
      throw new VerificationError(500, 'VERIFICATION_FAILED', details.message);
    }
  }

  async getVerification(id) {
    await this.ensureTable();
    const row = await this.loadRow(id);
    return publicRecord(mapRow(row));
  }

  async getSource(id) {
    await this.ensureTable();
    let row = await this.db.get(`SELECT * FROM ${TABLE_NAME} WHERE id = ?`, [
      id,
    ]);

    if (!row) {
      row = await this.db.get(
        `SELECT * FROM ${TABLE_NAME} WHERE contract_id = ?
         ORDER BY updated_at DESC LIMIT 1`,
        [id]
      );
    }

    if (!row) {
      throw new VerificationError(
        404,
        'VERIFICATION_NOT_FOUND',
        'Verification record not found'
      );
    }

    if (row.status !== 'verified') {
      throw new VerificationError(
        409,
        'SOURCE_NOT_VERIFIED',
        'Source code is only available for verified contracts'
      );
    }

    return {
      id: row.id,
      contractId: row.contract_id,
      network: row.network,
      sourceCode: row.source_code,
      sourceHash: row.source_hash,
      verifiedAt: row.verified_at || null,
      files: [{ path: 'src/lib.rs', content: row.source_code }],
    };
  }

  async searchVerifications({
    contractId,
    network,
    status,
    limit = 50,
    offset = 0,
  } = {}) {
    const records = await this.listVerifications({
      contractId,
      network,
      status,
      limit,
    });

    return {
      records,
      total: records.length,
      limit: Math.min(Math.max(Number(limit) || 50, 1), 200),
      offset: Math.max(Number(offset) || 0, 0),
    };
  }

  async listVerifications({ contractId, network, status, limit = 50 } = {}) {
    await this.ensureTable();
    const clauses = [];
    const params = [];
    if (contractId) {
      clauses.push('contract_id = ?');
      params.push(validateContractId(contractId));
    }
    if (network) {
      clauses.push('network = ?');
      params.push(network);
    }
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await this.db.all(
      `SELECT * FROM ${TABLE_NAME} ${where} ORDER BY
       updated_at DESC LIMIT ?`,
      [...params, Math.min(Math.max(limit, 1), 200)]
    );
    return rows.map((row) => publicRecord(mapRow(row)));
  }
}

export default VerifyService;
