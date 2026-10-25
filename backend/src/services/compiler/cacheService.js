// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT
//
// BE-11: Zero-Knowledge Compilation Cache with Content-Addressed Hash Keys
//
// Design:
//   1. Deterministic cache key: SHA256(sorted-file-contents + Cargo.lock + rustVersion + optimizationFlags)
//   2. Hot index: Redis (sub-5ms lookups) with TTL
//   3. Cold storage: S3-compatible object storage (WASM + diagnostics)
//   4. In-process LRU: bounded memory eviction for the hottest artifacts
//   5. Cryptographic digest check on every cache hit to prevent cache-poisoning

import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { LRUCache } from 'lru-cache';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

// ─── Constants ───────────────────────────────────────────────────────────────

const REDIS_KEY_PREFIX = 'compile:cache:v1:';
/** 30-day TTL for Redis hot-index entries */
const REDIS_TTL_SECONDS = 60 * 60 * 24 * 30;
/** LRU size cap: max 256 MiB of in-process WASM bytes */
const LRU_MAX_SIZE_BYTES = 256 * 1024 * 1024;
/** LRU TTL mirrors Redis so eviction is consistent */
const LRU_TTL_MS = REDIS_TTL_SECONDS * 1000;
/** S3 path prefix for all compiler artifacts */
const S3_PREFIX = 'compiler-cache/';
/** S3 path suffix for WASM binaries */
const S3_WASM_SUFFIX = '.wasm';
/** S3 path suffix for diagnostics JSON */
const S3_DIAG_SUFFIX = '.diagnostics.json';

// ─── S3 client helper ────────────────────────────────────────────────────────

function buildS3Client() {
  return new S3Client({
    endpoint: process.env.S3_ENDPOINT ?? process.env.R2_ENDPOINT,
    region: process.env.S3_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId:
        (process.env.S3_ACCESS_KEY_ID ?? process.env.R2_ACCESS_KEY_ID) || '',
      secretAccessKey:
        (process.env.S3_SECRET_ACCESS_KEY ??
          process.env.R2_SECRET_ACCESS_KEY) ||
        '',
    },
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Collect a Node.js Readable stream into a Buffer.
 * @param {Readable} stream
 * @returns {Promise<Buffer>}
 */
async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) =>
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    );
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/**
 * Compute the SHA-256 hex digest of a Buffer or string.
 * @param {Buffer|string} data
 * @returns {string} 64-character lowercase hex digest
 */
export function sha256hex(data) {
  return crypto
    .createHash('sha256')
    .update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data)
    .digest('hex');
}

// ─── Core cache-key derivation ───────────────────────────────────────────────

/**
 * Compute a deterministic, content-addressed SHA-256 cache key from the
 * supplied compilation inputs.
 *
 * Algorithm:
 *   1. Sort source file paths lexicographically.
 *   2. For each path (in order) feed `path\0content\0` into the hash.
 *   3. Feed Cargo.lock contents.
 *   4. Feed Rust version string.
 *   5. Feed sorted optimization flags joined with space.
 *
 * Sorting guarantees the key is identical regardless of file discovery order
 * or flag ordering, preventing false-positive cache collisions.
 *
 * @param {{
 *   sourceFiles: Record<string, string>,
 *   cargoLock: string,
 *   rustVersion: string,
 *   optimizationFlags: string[]
 * }} inputs
 * @returns {string} 64-character hex SHA-256 digest
 */
export function computeCacheKey(inputs) {
  const hasher = crypto.createHash('sha256');

  // 1. Source files – sort paths to ensure determinism
  const sortedPaths = Object.keys(inputs.sourceFiles).sort();
  for (const filePath of sortedPaths) {
    hasher.update(filePath);
    hasher.update('\0');
    hasher.update(inputs.sourceFiles[filePath]);
    hasher.update('\0');
  }

  // 2. Cargo.lock
  hasher.update(inputs.cargoLock ?? '');
  hasher.update('\0');

  // 3. Rust version
  hasher.update(inputs.rustVersion ?? '');
  hasher.update('\0');

  // 4. Optimization flags – sort to be deterministic
  const sortedFlags = [...inputs.optimizationFlags].sort();
  hasher.update(sortedFlags.join(' '));

  return hasher.digest('hex');
}

// ─── CompilationCacheService ─────────────────────────────────────────────────

/**
 * Manages the three-tier compilation cache:
 *   Tier 1 — in-process LRU (microsecond latency, bounded memory)
 *   Tier 2 — Redis hot-index (sub-5ms network latency)
 *   Tier 3 — S3-compatible object storage (durable cold storage)
 *
 * Every cache hit is validated against a stored SHA-256 digest before the
 * artifact is returned, preventing cache-poisoning attacks.
 */
export class CompilationCacheService {
  constructor() {
    this.lru = new LRUCache({
      maxSize: LRU_MAX_SIZE_BYTES,
      sizeCalculation: (entry) => Math.max(1, entry.sizeBytes),
      ttl: LRU_TTL_MS,
      updateAgeOnGet: true,
      updateAgeOnHas: true,
    });

    /** @type {S3Client|null} */
    this._s3Client = null;

    this.s3Bucket =
      process.env.S3_BUCKET ?? process.env.R2_BUCKET ?? 'soroban-playground';

    // S3 is enabled when credentials are present
    const hasCredentials = Boolean(
      (process.env.S3_ACCESS_KEY_ID ?? process.env.R2_ACCESS_KEY_ID) &&
      (process.env.S3_SECRET_ACCESS_KEY ?? process.env.R2_SECRET_ACCESS_KEY)
    );
    this.s3Enabled =
      hasCredentials && process.env.COMPILE_CACHE_S3_DISABLED !== 'true';

    // Observability counters
    this._hits = 0;
    this._misses = 0;
    this._stores = 0;
    this._digestFailures = 0;
    // Set this._redisOverride in tests to inject a mock Redis instance.
    // undefined = use real redisService; null = disabled; object = mock
    this._redisOverride = undefined;
  }

  // ── Private: lazy S3 client ──────────────────────────────────────────────

  _getS3() {
    if (!this._s3Client) {
      this._s3Client = buildS3Client();
    }
    return this._s3Client;
  }

  // ── Private: Redis helpers ───────────────────────────────────────────────

  /**
   * Safely import and return the shared redisService singleton.
   * `this._redisOverride` can be set by tests to inject a mock.
   */
  async _getRedis() {
    // Allow test injection via instance property
    if (this._redisOverride !== undefined) {
      return this._redisOverride;
    }
    try {
      const mod = await import('../redisService.js');
      const svc = mod.default ?? mod;
      if (svc?.isFallbackMode === true || !svc?.client) return null;
      return svc;
    } catch {
      return null;
    }
  }

  async _redisGet(key) {
    const redis = await this._getRedis();
    if (!redis) return null;
    try {
      return await redis.get(`${REDIS_KEY_PREFIX}${key}`);
    } catch {
      return null;
    }
  }

  async _redisSet(key, value) {
    const redis = await this._getRedis();
    if (!redis) return;
    try {
      await redis.set(`${REDIS_KEY_PREFIX}${key}`, value, REDIS_TTL_SECONDS);
    } catch {
      // swallow — Redis is a best-effort hot index
    }
  }

  async _redisDel(key) {
    const redis = await this._getRedis();
    if (!redis) return;
    try {
      await redis.delete(`${REDIS_KEY_PREFIX}${key}`);
    } catch {
      // swallow
    }
  }

  // ── Private: S3 helpers ──────────────────────────────────────────────────

  _s3WasmKey(hash) {
    return `${S3_PREFIX}${hash}${S3_WASM_SUFFIX}`;
  }

  _s3DiagKey(hash) {
    return `${S3_PREFIX}${hash}${S3_DIAG_SUFFIX}`;
  }

  async _s3Put(key, body, contentType) {
    if (!this.s3Enabled) return;
    try {
      await this._getS3().send(
        new PutObjectCommand({
          Bucket: this.s3Bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        })
      );
    } catch (err) {
      console.warn(`[cacheService] S3 put failed for ${key}:`, err?.message);
    }
  }

  async _s3Get(key) {
    if (!this.s3Enabled) return null;
    try {
      const res = await this._getS3().send(
        new GetObjectCommand({ Bucket: this.s3Bucket, Key: key })
      );
      if (!res.Body) return null;
      return await streamToBuffer(res.Body);
    } catch (err) {
      if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
        return null;
      }
      console.warn(`[cacheService] S3 get failed for ${key}:`, err?.message);
      return null;
    }
  }

  async _s3Delete(key) {
    if (!this.s3Enabled) return;
    try {
      await this._getS3().send(
        new DeleteObjectCommand({ Bucket: this.s3Bucket, Key: key })
      );
    } catch {
      // swallow
    }
  }

  // ── Private: result builder ──────────────────────────────────────────────

  _buildHit(entry) {
    return {
      hit: true,
      hash: entry.hash,
      wasmBytes: entry.wasmBytes,
      sizeBytes: entry.sizeBytes,
      diagnostics: entry.diagnostics,
      wasmDigest: entry.wasmDigest,
      createdAt: entry.createdAt,
    };
  }

  // ── Public: digest verification ──────────────────────────────────────────

  /**
   * Verify the SHA-256 digest of a WASM buffer against the stored reference.
   * Returns true if the artifact is untampered, false if it has been corrupted.
   *
   * @param {Buffer} wasmBytes
   * @param {string} expectedDigest
   * @returns {boolean}
   */
  verifyDigest(wasmBytes, expectedDigest) {
    return sha256hex(wasmBytes) === expectedDigest;
  }

  // ── Public: cache key derivation ────────────────────────────────────────

  /**
   * Convenience wrapper around the module-level pure function.
   * @param {object} inputs
   * @returns {string}
   */
  computeKey(inputs) {
    return computeCacheKey(inputs);
  }

  // ── Public: lookup (read path) ────────────────────────────────────────────

  /**
   * Look up a compiled artifact by its cache key hash.
   *
   * Resolution order:
   *   1. In-process LRU  (sub-ms)
   *   2. Redis hot-index (sub-5ms) → promotes to LRU on hit
   *   3. S3 cold storage           → promotes to Redis + LRU on hit
   *
   * Every hit path runs a digest check. An artifact that fails is evicted from
   * all tiers and a miss is returned, forcing recompilation.
   *
   * @param {string} hash
   * @returns {Promise<{hit: boolean, hash: string, wasmBytes?: Buffer, sizeBytes?: number, diagnostics?: object[], wasmDigest?: string, createdAt?: string}>}
   */
  async lookup(hash) {
    // ── Tier 1: LRU ──────────────────────────────────────────────────────
    const lruEntry = this.lru.get(hash);
    if (lruEntry) {
      if (!this.verifyDigest(lruEntry.wasmBytes, lruEntry.wasmDigest)) {
        this._digestFailures++;
        console.warn(
          `[cacheService] Digest mismatch in LRU for hash ${hash}; evicting`
        );
        this.lru.delete(hash);
        await this.evict(hash);
        this._misses++;
        return { hit: false, hash };
      }
      this._hits++;
      return this._buildHit(lruEntry);
    }

    // ── Tier 2: Redis ─────────────────────────────────────────────────────
    const redisRaw = await this._redisGet(hash);
    if (redisRaw) {
      let entry = null;
      try {
        entry = JSON.parse(redisRaw);
      } catch {
        // malformed Redis entry – evict and treat as miss
        await this._redisDel(hash);
      }

      if (entry) {
        // Fetch WASM from S3 to enable digest verification
        const wasmBytes = await this._s3Get(entry.s3WasmKey);
        if (wasmBytes && this.verifyDigest(wasmBytes, entry.wasmDigest)) {
          const lruFull = { ...entry, wasmBytes };
          this.lru.set(hash, lruFull);
          this._hits++;
          return this._buildHit(lruFull);
        }
        // Digest failure or S3 miss — evict stale Redis entry
        if (wasmBytes) {
          this._digestFailures++;
          console.warn(
            `[cacheService] Digest mismatch from Redis/S3 for hash ${hash}; evicting`
          );
        }
        await this.evict(hash);
        this._misses++;
        return { hit: false, hash };
      }
    }

    // ── Tier 3: S3 cold storage ───────────────────────────────────────────
    if (this.s3Enabled) {
      const wasmKey = this._s3WasmKey(hash);
      const diagKey = this._s3DiagKey(hash);

      const [wasmBytes, diagRaw] = await Promise.all([
        this._s3Get(wasmKey),
        this._s3Get(diagKey),
      ]);

      if (wasmBytes && diagRaw) {
        let entry = null;
        try {
          entry = JSON.parse(diagRaw.toString('utf8'));
        } catch {
          // Corrupt metadata — treat as miss
        }

        if (entry && this.verifyDigest(wasmBytes, entry.wasmDigest)) {
          // Promote to Redis + LRU
          const lruFull = { ...entry, wasmBytes };
          this.lru.set(hash, lruFull);
          await this._redisSet(hash, JSON.stringify(entry));
          this._hits++;
          return this._buildHit(lruFull);
        }

        if (entry && wasmBytes) {
          this._digestFailures++;
          console.warn(
            `[cacheService] Digest mismatch from S3 cold storage for hash ${hash}`
          );
        }
      }
    }

    this._misses++;
    return { hit: false, hash };
  }

  // ── Public: store (write path) ────────────────────────────────────────────

  /**
   * Persist a successfully compiled artifact to all three cache tiers.
   *
   * @param {string}   hash        Content-addressed cache key
   * @param {Buffer}   wasmBytes   Raw WASM binary
   * @param {object[]} diagnostics Compiler diagnostics (warnings, notes)
   * @returns {Promise<object>} The stored cache entry metadata
   */
  async store(hash, wasmBytes, diagnostics = []) {
    const wasmDigest = sha256hex(wasmBytes);
    const s3WasmKey = this._s3WasmKey(hash);
    const s3DiagKey = this._s3DiagKey(hash);

    const entry = {
      hash,
      wasmDigest,
      sizeBytes: wasmBytes.byteLength,
      createdAt: new Date().toISOString(),
      diagnostics,
      s3WasmKey,
      s3DiagKey,
    };

    // Persist to S3 (non-blocking best-effort)
    await Promise.all([
      this._s3Put(s3WasmKey, wasmBytes, 'application/wasm'),
      this._s3Put(s3DiagKey, JSON.stringify(entry), 'application/json'),
    ]);

    // Populate Redis hot-index
    await this._redisSet(hash, JSON.stringify(entry));

    // Populate in-process LRU
    const lruFull = { ...entry, wasmBytes };
    this.lru.set(hash, lruFull);

    this._stores++;
    return entry;
  }

  // ── Public: eviction ──────────────────────────────────────────────────────

  /**
   * Remove a specific artifact from all cache tiers.
   * @param {string} hash
   */
  async evict(hash) {
    this.lru.delete(hash);
    await this._redisDel(hash);
    if (this.s3Enabled) {
      await Promise.all([
        this._s3Delete(this._s3WasmKey(hash)),
        this._s3Delete(this._s3DiagKey(hash)),
      ]);
    }
  }

  // ── Public: statistics ────────────────────────────────────────────────────

  /**
   * Return observability counters.
   * @returns {{hits: number, misses: number, stores: number, digestFailures: number, hitRatio: number, lruSize: number, lruEntryCount: number, s3Enabled: boolean}}
   */
  getStats() {
    const total = this._hits + this._misses;
    return {
      hits: this._hits,
      misses: this._misses,
      stores: this._stores,
      digestFailures: this._digestFailures,
      hitRatio: total > 0 ? this._hits / total : 0,
      lruSize: this.lru.calculatedSize ?? 0,
      lruEntryCount: this.lru.size,
      s3Enabled: this.s3Enabled,
    };
  }

  /** Reset stats counters — useful in tests or after rolling restarts */
  resetStats() {
    this._hits = 0;
    this._misses = 0;
    this._stores = 0;
    this._digestFailures = 0;
  }
}

// ─── Module-level singleton ──────────────────────────────────────────────────

export const compilationCacheService = new CompilationCacheService();
export default compilationCacheService;
