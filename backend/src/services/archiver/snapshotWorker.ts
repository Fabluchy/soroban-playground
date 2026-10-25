import { createHash } from 'node:crypto';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';

const DEFAULT_RANGE_SIZE = 500;
const DEFAULT_BUCKET =
  process.env.SNAPSHOT_ARCHIVE_BUCKET || process.env.S3_BUCKET;

async function zstd() {
  const codec = await import('node:zlib');
  if (!codec.zstdCompress || !codec.zstdDecompress) {
    throw new Error('Zstandard compression requires Node.js 22.15 or newer');
  }
  return codec;
}

function encode(value) {
  return Buffer.from(JSON.stringify(value));
}

async function bodyBuffer(body) {
  if (body?.transformToByteArray)
    return Buffer.from(await body.transformToByteArray());
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function normalizeDiffs(changes, ledger) {
  if (!Array.isArray(changes)) return [];
  return changes
    .map((change) => {
      const contractId = change.contractId ?? change.contract_id;
      const key = change.key ?? change.ledgerKey ?? change.ledger_key;
      if (!contractId || key === undefined) return null;
      const value = change.deleted
        ? null
        : (change.value ?? change.after ?? null);
      return {
        contractId,
        key: typeof key === 'string' ? key : JSON.stringify(key),
        value,
        ledger,
      };
    })
    .filter(Boolean);
}

/** Create an async iterable from a Stellar Core/Horizon-compatible SSE endpoint. */
export async function* streamLedgerEvents({
  url = process.env.STELLAR_LEDGER_STREAM_URL,
  fetchImpl = globalThis.fetch,
  cursor = 'now',
  signal,
  headers = {},
} = {}) {
  if (!url) throw new Error('STELLAR_LEDGER_STREAM_URL is required');
  if (typeof fetchImpl !== 'function')
    throw new Error('fetch is not available');
  const endpoint = new URL(url);
  if (cursor) endpoint.searchParams.set('cursor', cursor);
  const response = await fetchImpl(endpoint, {
    headers: { accept: 'text/event-stream', ...headers },
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`ledger stream returned HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) yield JSON.parse(data);
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Streams ledger-close records, stores compressed range archives, and maintains
 * a contract/ledger checkpoint index for bounded historical reconstruction.
 * A stream adapter should yield { sequence, changes }; `extractChanges` can
 * translate a Core change stream's native ledger-entry format.
 */
export class SnapshotWorker {
  constructor({
    stream,
    extractChanges = (ledger) => ledger.changes ?? ledger.stateChanges ?? [],
    s3 = new S3Client({ region: process.env.S3_REGION || 'us-east-1' }),
    bucket = DEFAULT_BUCKET,
    prefix = 'soroban-ledger-snapshots',
    rangeSize = DEFAULT_RANGE_SIZE,
    logger = console,
  } = {}) {
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
      throw new TypeError('stream must be an async iterable of closed ledgers');
    }
    if (!bucket)
      throw new Error('SNAPSHOT_ARCHIVE_BUCKET or S3_BUCKET is required');
    if (!Number.isInteger(rangeSize) || rangeSize < 1)
      throw new RangeError('rangeSize must be a positive integer');
    this.stream = stream;
    this.extractChanges = extractChanges;
    this.s3 = s3;
    this.bucket = bucket;
    this.prefix = prefix.replace(/^\/+|\/+$/g, '');
    this.rangeSize = rangeSize;
    this.logger = logger;
    this.pending = [];
    this.state = new Map();
    this.lastSequence = 0;
    this.running = false;
    this.abortController = null;
  }

  async start({ signal } = {}) {
    if (this.running) throw new Error('snapshot worker is already running');
    this.running = true;
    this.abortController = new AbortController();
    const stop = () => this.abortController.abort();
    signal?.addEventListener('abort', stop, { once: true });
    try {
      for await (const ledger of this.stream({
        signal: this.abortController.signal,
      })) {
        if (this.abortController.signal.aborted) break;
        const sequence = Number(ledger.sequence ?? ledger.seq);
        if (!Number.isSafeInteger(sequence) || sequence < 1)
          throw new Error('ledger close event has an invalid sequence');
        if (sequence <= this.lastSequence) continue;
        if (this.lastSequence && sequence !== this.lastSequence + 1) {
          throw new Error(
            `ledger stream gap: expected ${this.lastSequence + 1}, received ${sequence}`
          );
        }
        const changes = normalizeDiffs(
          await this.extractChanges(ledger),
          sequence
        );
        for (const diff of changes) this.applyChange(diff);
        this.pending.push({ sequence, changes });
        this.lastSequence = sequence;
        if (
          this.pending.length >= this.rangeSize ||
          sequence % this.rangeSize === 0
        )
          await this.flush();
      }
    } finally {
      signal?.removeEventListener('abort', stop);
      this.running = false;
      if (this.pending.length) await this.flush();
    }
  }

  stop() {
    this.abortController?.abort();
  }

  applyChange({ contractId, key, value }) {
    if (!this.state.has(contractId)) this.state.set(contractId, new Map());
    const contract = this.state.get(contractId);
    if (value === null) contract.delete(key);
    else contract.set(key, value);
  }

  async flush() {
    if (!this.pending.length) return null;
    const codec = await zstd();
    const ledgers = this.pending;
    const start = ledgers[0].sequence;
    const end = ledgers.at(-1).sequence;
    const archive = {
      version: 1,
      compression: 'zstd',
      startLedger: start,
      endLedger: end,
      ledgers,
    };
    const raw = encode(archive);
    const compressed = await new Promise((resolve, reject) =>
      codec.zstdCompress(
        raw,
        { params: { [codec.constants.ZSTD_c_compressionLevel]: 9 } },
        (error, result) => (error ? reject(error) : resolve(result))
      )
    );
    const digest = createHash('sha256').update(compressed).digest('hex');
    const archiveKey = `${this.prefix}/ranges/${start}-${end}.json.zst`;
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: archiveKey,
        Body: compressed,
        ContentType: 'application/zstd',
        Metadata: {
          start: String(start),
          end: String(end),
          sha256: digest,
          compression: 'zstd',
          level: '9',
        },
      })
    );

    // Ledger pointers and materialized checkpoints make lookup independent of
    // listing/scanning old archives. Checkpoints are written only after archive.
    for (const item of ledgers) {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: `${this.prefix}/index/ledgers/${item.sequence}.json`,
          Body: encode({ sequence: item.sequence, archiveKey, start, end }),
          ContentType: 'application/json',
        })
      );
    }
    const snapshot = Object.fromEntries(
      [...this.state].map(([contractId, entries]) => [
        contractId,
        Object.fromEntries(entries),
      ])
    );
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: `${this.prefix}/index/checkpoints/${end}.json`,
        Body: encode({ ledger: end, state: snapshot }),
        ContentType: 'application/json',
      })
    );
    this.pending = [];
    this.logger.info?.(
      `Archived ledgers ${start}-${end} (${raw.length} -> ${compressed.length} bytes, ${Math.round((1 - compressed.length / raw.length) * 100)}% reduction)`
    );
    return {
      start,
      end,
      archiveKey,
      originalBytes: raw.length,
      compressedBytes: compressed.length,
      sha256: digest,
    };
  }

  async getJson(key) {
    const result = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key })
    );
    return JSON.parse((await bodyBuffer(result.Body)).toString('utf8'));
  }

  /** Restore a complete contract state at a ledger, using the nearest checkpoint. */
  async restoreContractState(contractId, targetLedger) {
    const target = Number(targetLedger);
    if (!Number.isSafeInteger(target) || target < 1)
      throw new RangeError('targetLedger must be a positive integer');
    const checkpointEnd = Math.floor(target / this.rangeSize) * this.rangeSize;
    let state = new Map();
    let fromLedger = 1;
    if (checkpointEnd > 0) {
      try {
        const checkpoint = await this.getJson(
          `${this.prefix}/index/checkpoints/${checkpointEnd}.json`
        );
        state = new Map(Object.entries(checkpoint.state?.[contractId] ?? {}));
        fromLedger = checkpoint.ledger + 1;
      } catch (error) {
        if (
          error?.name !== 'NoSuchKey' &&
          error?.$metadata?.httpStatusCode !== 404
        )
          throw error;
      }
    }
    const ranges = new Map();
    for (let sequence = fromLedger; sequence <= target; sequence += 1) {
      let pointer;
      try {
        pointer = await this.getJson(
          `${this.prefix}/index/ledgers/${sequence}.json`
        );
      } catch (error) {
        if (
          error?.name === 'NoSuchKey' ||
          error?.$metadata?.httpStatusCode === 404
        )
          break;
        throw error;
      }
      if (!ranges.has(pointer.archiveKey)) {
        const codec = await zstd();
        const object = await this.s3.send(
          new GetObjectCommand({ Bucket: this.bucket, Key: pointer.archiveKey })
        );
        const compressed = await bodyBuffer(object.Body);
        const raw = await new Promise((resolve, reject) =>
          codec.zstdDecompress(compressed, (error, result) =>
            error ? reject(error) : resolve(result)
          )
        );
        ranges.set(pointer.archiveKey, JSON.parse(raw.toString('utf8')));
      }
      const archive = ranges.get(pointer.archiveKey);
      for (const ledger of archive.ledgers) {
        if (ledger.sequence < fromLedger || ledger.sequence > target) continue;
        for (const change of ledger.changes) {
          if (change.contractId !== contractId) continue;
          if (change.value === null) state.delete(change.key);
          else state.set(change.key, change.value);
        }
      }
    }
    return Object.fromEntries(state);
  }
}

export default SnapshotWorker;
